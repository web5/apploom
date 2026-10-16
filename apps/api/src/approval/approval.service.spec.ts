import { createDefaultRegistry } from '@apploom/tools';
import { mkdtempSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ApprovalService } from './approval.service';
import type { PipelineEvent } from '../pipeline/pipeline.types';

function setup() {
  const events: PipelineEvent[] = [];
  const bus = { emit: jest.fn((_id: string, e: PipelineEvent) => void events.push(e)) };
  return { svc: new ApprovalService(bus as never), events };
}
const req = { docId: 'd1', stage: 'deploy' as const, tool: 'kill_port', summary: '终止 PID 1', risk: 'high' as const };

describe('ApprovalService', () => {
  beforeEach(() => {
    delete process.env.HITL_MODE;
    delete process.env.HITL_TIMEOUT_MS;
  });
  afterEach(() => jest.useRealTimers());

  it('ask 模式：挂起并推送 approval 事件，批准后放行', async () => {
    const { svc, events } = setup();
    const p = svc.request(req);

    const pending = svc.list('d1');
    expect(pending).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'approval', approval: { id: pending[0].id, tool: 'kill_port', risk: 'high' } });

    expect(svc.decide('d1', pending[0].id, 'approve')).toBe(true);
    await expect(p).resolves.toBe('allowed-once');
    expect(svc.list('d1')).toHaveLength(0);
    expect(events[1]).toMatchObject({ type: 'approval-resolved', decision: 'allowed-once' });
  });

  it('拒绝 → rejected；重复决策或错误的 docId 返回 false', async () => {
    const { svc } = setup();
    const p = svc.request(req);
    const id = svc.list('d1')[0].id;
    expect(svc.decide('other-doc', id, 'approve')).toBe(false);
    expect(svc.decide('d1', id, 'reject')).toBe(true);
    await expect(p).resolves.toBe('rejected');
    expect(svc.decide('d1', id, 'approve')).toBe(false);
  });

  it('超时未决策 → unavailable（默认不放行）', async () => {
    jest.useFakeTimers();
    process.env.HITL_TIMEOUT_MS = '1000';
    const { svc } = setup();
    const p = svc.request(req);
    await jest.advanceTimersByTimeAsync(1001);
    await expect(p).resolves.toBe('unavailable');
    expect(svc.list('d1')).toHaveLength(0);
  });

  it('HITL_MODE=auto 直接放行，deny 直接拒绝，都不产生待审批项', async () => {
    const { svc, events } = setup();
    process.env.HITL_MODE = 'auto';
    await expect(svc.request(req)).resolves.toBe('allowed-once');
    process.env.HITL_MODE = 'deny';
    await expect(svc.request(req)).resolves.toBe('rejected');
    expect(events).toHaveLength(0);
  });
});

describe('approverFor + ToolRegistry：策略由代码执行', () => {
  const tools = createDefaultRegistry();
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'apploom-hitl-')));

  beforeEach(() => delete process.env.HITL_MODE);

  it('白名单命令直接放行，不打扰人', async () => {
    const { svc, events } = setup();
    const r = await tools.execute('shell', { command: 'npm', args: ['--version'], cwd: '.' }, { workspace, approver: svc.approverFor('d1', 'codegen') });
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('破坏性命令在任何模式下都拒绝且不执行', async () => {
    const { svc } = setup();
    process.env.HITL_MODE = 'auto';
    const marker = path.join(workspace, 'should-not-exist');
    const r = await tools.execute('shell', { command: 'sudo', args: ['touch', marker], cwd: '.' }, { workspace, approver: svc.approverFor('d1', 'codegen') });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('被用户拒绝');
    expect(existsSync(marker)).toBe(false);
  });

  it('可疑命令等待人工：批准才执行，拒绝则不执行', async () => {
    const { svc } = setup();
    const marker = path.join(workspace, 'marker.txt');
    writeFileSync(path.join(workspace, 'a.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);

    const rejected = tools.execute('shell', { command: 'node', args: ['a.js'], cwd: '.' }, { workspace, approver: svc.approverFor('d1', 'codegen') });
    svc.decide('d1', svc.list('d1')[0].id, 'reject');
    expect((await rejected).ok).toBe(false);
    expect(existsSync(marker)).toBe(false);

    const approved = tools.execute('shell', { command: 'node', args: ['a.js'], cwd: '.' }, { workspace, approver: svc.approverFor('d1', 'codegen') });
    svc.decide('d1', svc.list('d1')[0].id, 'approve');
    expect((await approved).ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});
