/**
 * 过期级联（STAGE_STALE_CASCADE）的服务层场景：完整五阶段流水线，修复中间某阶段后观察下游的走向。
 * 阶段产出由测试按「第几次调用」控制，因此可以精确构造「上游重新生成后内容相同 / 不同」两种情况。
 */
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ on: jest.fn(), quit: jest.fn() })) }));

import { rmSync } from 'node:fs';
import { PipelineService } from './pipeline.service';
import { fingerprint } from './fingerprint';
import { createPipelineDoc, PIPELINE_STAGES, type AttemptRecord, type PipelineDoc, type PipelineEvent, type PipelineStage } from './pipeline.types';
import { withRun } from './test-llm';

class FakeStore {
  constructor(public doc: PipelineDoc) {}
  async get() { return structuredClone(this.doc); }
  async save(d: PipelineDoc) { this.doc = d; }
  async update(_id: string, fn: (d: PipelineDoc) => void) { fn(this.doc); return this.doc; }
  async mutate<T>(_id: string, fn: (d: PipelineDoc, skip: () => void) => T) {
    const result = fn(this.doc, () => undefined);
    return { doc: structuredClone(this.doc), result };
  }
}

const DOC_ID = 'stale-spec';

/** version[stage](n) = 该阶段第 n 次生成的产出；默认每次都相同（用 'same'），测试按需让某阶段第 2 次起不同 */
function setup(versions: Partial<Record<PipelineStage, (n: number) => unknown>> = {}) {
  const doc = createPipelineDoc('做计数器', false);
  doc.id = DOC_ID;
  doc.currentStage = 'requirement';
  const store = new FakeStore(doc);
  const events: PipelineEvent[] = [];
  const bus = { emit: jest.fn((_i: string, e: PipelineEvent) => void events.push(e)) };
  const out = (stage: PipelineStage, n: number) => (versions[stage] ? versions[stage]!(n) : { stage, v: 'same' });
  const calls: Record<string, number> = {};
  const count = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
  const llm = withRun({
    generatePrd: jest.fn(async () => ({ raw: 'r', prd: out('requirement', count('requirement')), summary: { warnings: [] } })),
    generatePrototype: jest.fn(async () => ({ raw: 'r', prototype: out('prototype', count('prototype')), summary: { warnings: [] } })),
    generateDesign: jest.fn(async () => ({ raw: 'r', design: out('design', count('design')), summary: { warnings: [] } })),
    generateCodegen: jest.fn(async () => ({ raw: 'r', codegen: { files: [{ path: 'a', content: 'x' }], dependencies: [], runCommand: 'npm run dev', notes: [], v: out('codegen', count('codegen')) }, summary: { warnings: [] } })),
    generateDeploy: jest.fn(async () => { count('deploy'); return { raw: 'r', deploy: { target: 'local', url: '', repoUrl: '', buildLog: '', status: 'success', port: 5173 }, summary: { warnings: [] } }; }),
  } as Record<string, jest.Mock>);
  const deploySvc = { deploy: jest.fn(async () => ({ url: 'http://localhost:5173', buildLog: 'ok', status: 'success' })) };
  const gate = { verify: jest.fn(async () => ({ passed: true, failures: [], checks: [] })) };
  const records: AttemptRecord[] = [];
  const trace = { append: jest.fn(async (r: AttemptRecord) => void records.push(r)), list: jest.fn(async () => records) };
  const jobs: Array<{ name: string; data: { docId: string; stage: PipelineStage; seq?: number } }> = [];
  const svc = new PipelineService(store as never, bus as never, llm as never, deploySvc as never, gate as never, trace as never);
  (svc as unknown as { queue: unknown }).queue = { add: jest.fn(async (name: string, data: never) => void jobs.push({ name, data })) };
  const processStage = (data: { docId: string; stage: PipelineStage; seq?: number }) => (svc as unknown as { processStage(j: unknown): Promise<void> }).processStage({ data });
  /** 像 BullMQ 一样按 FIFO 消费所有 job，直到队列空 */
  async function drain(): Promise<PipelineStage[]> {
    const order: PipelineStage[] = [];
    for (let guard = 0; guard < 50 && jobs.length; guard++) {
      const job = jobs.shift()!;
      order.push(job.data.stage);
      await processStage(job.data);
    }
    return order;
  }
  const start = async () => { jobs.push({ name: 'requirement', data: { docId: DOC_ID, stage: 'requirement', seq: 1 } }); await drain(); };
  return { doc, svc, llm, deploySvc, events, calls, drain, start, records };
}

const statuses = (d: PipelineDoc) => PIPELINE_STAGES.map((s) => d.stages[s].status);
const generated = (llm: Record<string, jest.Mock>) => ({
  requirement: llm.generatePrd.mock.calls.length,
  prototype: llm.generatePrototype.mock.calls.length,
  design: llm.generateDesign.mock.calls.length,
  codegen: llm.generateCodegen.mock.calls.length,
  deploy: llm.generateDeploy.mock.calls.length,
});

describe('过期级联', () => {
  const saved = process.env.STAGE_STALE_CASCADE;
  beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => undefined); jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterAll(() => { jest.restoreAllMocks(); rmSync(`/tmp/apploom-artifacts/${DOC_ID}`, { recursive: true, force: true }); });
  afterEach(() => { if (saved === undefined) delete process.env.STAGE_STALE_CASCADE; else process.env.STAGE_STALE_CASCADE = saved; });

  it('v1a：完整跑完后每个阶段都有指纹与血统（与开关无关）', async () => {
    delete process.env.STAGE_STALE_CASCADE;
    const { doc, start } = setup();
    await start();
    expect(doc.status).toBe('completed');
    for (const s of PIPELINE_STAGES) {
      expect(doc.stages[s].fingerprint).toBe(fingerprint(doc.stages[s].result));
      expect(doc.stages[s].consumed).toBeDefined();
    }
    expect(doc.stages.requirement.consumed).toEqual({ '@input': fingerprint('做计数器') });
    expect(Object.keys(doc.stages.codegen.consumed!).sort()).toEqual(['design', 'prototype']);
    expect(doc.stages.deploy.consumed).toEqual({ codegen: doc.stages.codegen.fingerprint });
  });

  it('开关关闭（默认）：修复原型后，下游产物被清空，设计 / 代码 / 部署全部重新执行——与改动前完全一致', async () => {
    delete process.env.STAGE_STALE_CASCADE;
    const { doc, svc, llm, drain, start } = setup();
    await start();
    expect(generated(llm)).toEqual({ requirement: 1, prototype: 1, design: 1, codegen: 1, deploy: 1 });

    await svc.repair(DOC_ID, 'prototype', '换风格');
    expect(statuses(doc)).toEqual(['done', 'pending', 'pending', 'pending', 'pending']);
    expect(doc.stages.design.result).toBeUndefined();
    await drain();

    expect(generated(llm)).toEqual({ requirement: 1, prototype: 2, design: 2, codegen: 2, deploy: 2 });
    expect(doc.status).toBe('completed');
  });

  it('开关开启：修复后下游保留旧产物并标记 stale（可对照），而不是被清空', async () => {
    process.env.STAGE_STALE_CASCADE = '1';
    const { doc, svc, start } = setup();
    await start();
    const oldDesign = structuredClone(doc.stages.design.result);

    await svc.repair(DOC_ID, 'prototype', '换风格');
    expect(statuses(doc)).toEqual(['done', 'pending', 'stale', 'stale', 'stale']);
    expect(doc.stages.design.result).toEqual(oldDesign);
  });

  it('开关开启 + 上游重新生成出完全相同的产物：下游经指纹比对仍有效，全部沿用，不再调用模型 / 门禁 / 部署', async () => {
    process.env.STAGE_STALE_CASCADE = '1';
    const { doc, svc, llm, deploySvc, drain, start, events } = setup(); // 每个阶段每次产出都相同
    await start();

    await svc.repair(DOC_ID, 'prototype', '换风格');
    const order = await drain();

    expect(order).toEqual(['prototype', 'design', 'codegen', 'deploy']); // 链仍然走完，每一环都被调度到
    expect(generated(llm)).toEqual({ requirement: 1, prototype: 2, design: 1, codegen: 1, deploy: 1 }); // 只有原型重新生成
    expect(deploySvc.deploy).toHaveBeenCalledTimes(1); // 没有重复部署
    expect(statuses(doc)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(doc.status).toBe('completed');
    expect(doc.stages.design.attempts).toBe(1); // 没有产生新的执行
    // 被沿用的阶段会向前端补发一条 done 事件，界面才能从 stale 回到完成态
    const doneEvents = events.filter((e) => e.type === 'stage' && (e as { status: string }).status === 'done').map((e) => (e as { stage: string }).stage);
    expect(doneEvents.slice(-3)).toEqual(['design', 'codegen', 'deploy']);
  });

  it('开关开启 + 上游产物变了：只重跑真正受影响的阶段——design 变了所以 codegen 重跑；codegen 产出没变，所以 deploy 沿用', async () => {
    process.env.STAGE_STALE_CASCADE = '1';
    // 原型第 2 次生成不同；设计即使重跑，产出仍然相同；代码生成即使重跑，产出也相同
    const { doc, svc, llm, deploySvc, drain, start } = setup({ prototype: (n) => ({ v: n }) });
    await start();

    await svc.repair(DOC_ID, 'prototype', '换风格');
    await drain();

    // design 依据 prototype（变了）→ 重跑；codegen 依据 prototype（变了）→ 重跑；deploy 只依据 codegen（codegen 产出没变）→ 沿用
    expect(generated(llm)).toEqual({ requirement: 1, prototype: 2, design: 2, codegen: 2, deploy: 1 });
    expect(deploySvc.deploy).toHaveBeenCalledTimes(1);
    expect(doc.stages.design.attempts).toBe(2);
    expect(doc.stages.deploy.attempts).toBe(1);
    expect(statuses(doc)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('传播：中间阶段重跑后产出变了，更下游即使没被直接改动也会因血统不符而重跑', async () => {
    process.env.STAGE_STALE_CASCADE = '1';
    // 原型与设计第 2 次都不同；代码生成第 2 次也不同 → 部署必须重跑
    const { doc, svc, llm, deploySvc, drain, start } = setup({ prototype: (n) => ({ v: n }), design: (n) => ({ v: n }), codegen: (n) => ({ v: n }) });
    await start();
    await svc.repair(DOC_ID, 'prototype', '换风格');
    await drain();
    expect(generated(llm)).toEqual({ requirement: 1, prototype: 2, design: 2, codegen: 2, deploy: 2 });
    expect(deploySvc.deploy).toHaveBeenCalledTimes(2);
    expect(doc.status).toBe('completed');
  });

  it('旧数据（没有血统记录）处于 stale：无法证明有效，保守地重跑，不会误沿用', async () => {
    process.env.STAGE_STALE_CASCADE = '1';
    const { doc, svc, llm, drain, start } = setup();
    await start();
    for (const s of PIPELINE_STAGES) { doc.stages[s].consumed = undefined; doc.stages[s].fingerprint = undefined; } // 模拟升级前的老文档
    await svc.repair(DOC_ID, 'prototype', '换风格');
    await drain();
    expect(generated(llm)).toEqual({ requirement: 1, prototype: 2, design: 2, codegen: 2, deploy: 2 });
  });

  it('过期阶段收到过期的入队意图（seq 不符）：同样丢弃，不执行', async () => {
    process.env.STAGE_STALE_CASCADE = '1';
    const { doc, svc, llm, start } = setup();
    await start();
    await svc.repair(DOC_ID, 'prototype', 'x'); // design 变 stale，attempts=1，应有的下一个 seq 是 2
    expect(doc.stages.design.status).toBe('stale');
    const before = generated(llm);
    jestProcess(svc, { docId: DOC_ID, stage: 'design', seq: 1 }); // 迟到的旧意图
    await new Promise((r) => setTimeout(r, 20));
    expect(generated(llm)).toEqual(before);
    expect(doc.stages.design.status).toBe('stale');
  });
});

function jestProcess(svc: PipelineService, data: { docId: string; stage: PipelineStage; seq?: number }) {
  return (svc as unknown as { processStage(j: unknown): Promise<void> }).processStage({ data });
}
