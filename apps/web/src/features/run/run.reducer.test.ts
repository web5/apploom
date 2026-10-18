import { describe, expect, it } from 'vitest';
import type { ApprovalView, PipelineDoc } from '@apploom/shared';
import { STAGE_IDS } from '@apploom/shared/graph';
import { emptyTokens, initialRunState, runReducer, type RunAction, type RunState } from './run.reducer';

const doc = (over: Partial<PipelineDoc> = {}): PipelineDoc => ({
  id: 'd1', version: 1, requirement: '做计数器', status: 'running', confirmEachStep: true, currentStage: 'requirement',
  stages: Object.fromEntries(STAGE_IDS.map((s) => [s, { status: 'pending', attempts: 0 }])) as PipelineDoc['stages'],
  handoffs: Object.fromEntries(STAGE_IDS.map((s) => [s, false])) as PipelineDoc['handoffs'],
  createdAt: 't0', updatedAt: 't0', ...over,
});
const approval = (id: string): ApprovalView => ({ id, docId: 'd1', stage: 'deploy', tool: 'shell', summary: 's', risk: 'high', createdAt: 'a', expiresAt: 'b' });
const run = (actions: RunAction[], from: RunState = initialRunState) => actions.reduce(runReducer, from);

describe('runReducer', () => {
  it('初始状态：没有文档、没有连接、没有输出', () => {
    expect(initialRunState).toEqual({ doc: null, tokens: emptyTokens(), approvals: [], connected: false, error: '' });
    expect(Object.keys(initialRunState.tokens)).toEqual([...STAGE_IDS]);
  });

  it('不修改传入的状态（reducer 必须纯）', () => {
    const before = run([{ type: 'SNAPSHOT', doc: doc() }, { type: 'TOKEN', stage: 'requirement', token: 'a' }]);
    const frozen = JSON.stringify(before);
    run([{ type: 'STAGE', stage: 'requirement', status: 'done' }, { type: 'TOKEN', stage: 'requirement', token: 'b' }, { type: 'JOB', status: 'completed' }], before);
    expect(JSON.stringify(before)).toBe(frozen);
  });

  describe('订阅与连接', () => {
    it('开始订阅：清掉旧错误与审批并标记已连接；连接出错只改连接标记', () => {
      const s = run([{ type: 'ERROR_SET', message: '旧错误' }, { type: 'APPROVAL_ADDED', approval: approval('a1') }, { type: 'SUBSCRIBE_START' }]);
      expect(s).toMatchObject({ error: '', approvals: [], connected: true });
      expect(run([{ type: 'CONNECTION', connected: false }], s)).toMatchObject({ connected: false, error: '', approvals: [] });
    });

    it('重连补帧：快照整体覆盖文档，但保留已累积的流式输出与审批（断线期间页面上的内容不丢）', () => {
      const s1 = run([{ type: 'SUBSCRIBE_START' }, { type: 'SNAPSHOT', doc: doc() }, { type: 'TOKEN', stage: 'requirement', token: 'abc' }, { type: 'APPROVAL_ADDED', approval: approval('a1') }, { type: 'CONNECTION', connected: false }]);
      const s2 = run([{ type: 'SNAPSHOT', doc: doc({ version: 5, status: 'waiting_confirm' }) }], s1);
      expect(s2.doc).toMatchObject({ version: 5, status: 'waiting_confirm' });
      expect(s2.tokens.requirement).toBe('abc');
      expect(s2.approvals).toHaveLength(1);
    });
  });

  describe('阶段事件', () => {
    const withDoc = () => run([{ type: 'SNAPSHOT', doc: doc() }]);

    it('没有文档时忽略阶段事件和 job 事件（事件先于快照到达）', () => {
      expect(run([{ type: 'STAGE', stage: 'design', status: 'running' }, { type: 'JOB', status: 'running' }]).doc).toBeNull();
    });

    it('阶段完成：带上摘要与产出；没带的字段沿用旧值', () => {
      const s = run([
        { type: 'STAGE', stage: 'requirement', status: 'running', summary: { n: 1 } },
        { type: 'STAGE', stage: 'requirement', status: 'done', result: { prd: 1 } },
      ], withDoc());
      expect(s.doc!.stages.requirement).toMatchObject({ status: 'done', summary: { n: 1 }, result: { prd: 1 } });
    });

    it('阶段失败：记下原因与类别；之后一旦进入其它状态，旧的失败信息立刻清掉', () => {
      const failed = run([{ type: 'STAGE', stage: 'codegen', status: 'failed', error: '门禁未通过', errorClass: 'verification' }], withDoc());
      expect(failed.doc!.stages.codegen).toMatchObject({ status: 'failed', error: '门禁未通过', errorClass: 'verification' });
      const retried = run([{ type: 'STAGE', stage: 'codegen', status: 'running' }], failed);
      expect(retried.doc!.stages.codegen).toMatchObject({ status: 'running', error: undefined, errorClass: undefined });
    });

    it('失败事件没带原因时沿用文档里已有的原因（快照先到、失败事件后到）', () => {
      const s = run([
        { type: 'SNAPSHOT', doc: doc({ stages: { ...doc().stages, codegen: { status: 'failed', attempts: 1, error: '快照里的原因', errorClass: 'execution' } } }) },
        { type: 'STAGE', stage: 'codegen', status: 'failed' },
      ]);
      expect(s.doc!.stages.codegen).toMatchObject({ error: '快照里的原因', errorClass: 'execution' });
    });

    it('一个阶段的事件不影响别的阶段', () => {
      const s = run([{ type: 'STAGE', stage: 'design', status: 'done', result: { d: 1 } }], withDoc());
      expect(s.doc!.stages.requirement.status).toBe('pending');
      expect(s.doc!.stages.design.status).toBe('done');
    });

    it('job 事件只改整体状态', () => {
      const s = run([{ type: 'JOB', status: 'waiting_confirm' }], withDoc());
      expect(s.doc!.status).toBe('waiting_confirm');
      expect(s.doc!.currentStage).toBe('requirement');
    });

    it('stale 状态原样透传（过期级联开启时才会出现）', () => {
      const s = run([{ type: 'STAGE', stage: 'design', status: 'stale' }], withDoc());
      expect(s.doc!.stages.design.status).toBe('stale');
    });
  });

  describe('流式输出', () => {
    it('逐段累积，按阶段隔离', () => {
      const actions: RunAction[] = [
        { type: 'TOKEN', stage: 'requirement', token: '你' },
        { type: 'TOKEN', stage: 'requirement', token: '好' },
        { type: 'TOKEN', stage: 'design', token: 'X' },
      ];
      const s = run(actions);
      expect(s.tokens.requirement).toBe('你好');
      expect(s.tokens.design).toBe('X');
      expect(s.tokens.codegen).toBe('');
    });

    it('载入已有流水线 / 重置 / 断开都会清空流式输出', () => {
      const s = run([{ type: 'TOKEN', stage: 'requirement', token: 'abc' }]);
      for (const a of [{ type: 'DOC_LOADED', doc: doc() }, { type: 'RESET' }, { type: 'DISCONNECTED' }] as RunAction[]) {
        expect(runReducer(s, a).tokens).toEqual(emptyTokens());
      }
    });
  });

  describe('完成、错误与断开', () => {
    it('完成：以服务端最终文档为准，清空审批，关闭连接标记', () => {
      const s = run([{ type: 'SUBSCRIBE_START' }, { type: 'APPROVAL_ADDED', approval: approval('a1') }, { type: 'DONE', doc: doc({ status: 'completed', version: 9 }) }]);
      expect(s).toMatchObject({ connected: false, approvals: [] });
      expect(s.doc).toMatchObject({ status: 'completed', version: 9 });
    });

    it('流水线错误事件：带阶段中文名', () => {
      expect(run([{ type: 'PIPELINE_ERROR', stage: 'codegen', message: '预算用尽' }]).error).toBe('阶段「代码生成」失败：预算用尽');
    });

    it('重置：清空文档 / 输出 / 错误，但不动审批与连接标记（订阅时自己会处理）', () => {
      const s = run([{ type: 'SUBSCRIBE_START' }, { type: 'SNAPSHOT', doc: doc() }, { type: 'ERROR_SET', message: 'x' }, { type: 'RESET' }]);
      expect(s).toMatchObject({ doc: null, error: '', connected: true });
    });

    it('手动断开：清空文档与输出，连接置 false，并给出任务仍在后台执行的提示', () => {
      const s = run([{ type: 'SUBSCRIBE_START' }, { type: 'SNAPSHOT', doc: doc() }, { type: 'DISCONNECTED' }]);
      expect(s).toMatchObject({ doc: null, connected: false });
      expect(s.error).toContain('任务仍在后台执行');
    });
  });

  describe('审批', () => {
    it('重复的审批事件（重连后重放）不会产生重复项', () => {
      const s = run([{ type: 'APPROVAL_ADDED', approval: approval('a1') }, { type: 'APPROVAL_ADDED', approval: approval('a1') }, { type: 'APPROVAL_ADDED', approval: approval('a2') }]);
      expect(s.approvals.map((a) => a.id)).toEqual(['a1', 'a2']);
    });

    it('已处理 / 超时的审批被移除；移除不存在的 id 无副作用；接口返回的列表整体覆盖', () => {
      const s1 = run([{ type: 'APPROVAL_ADDED', approval: approval('a1') }, { type: 'APPROVAL_ADDED', approval: approval('a2') }]);
      expect(run([{ type: 'APPROVAL_REMOVED', id: 'a1' }], s1).approvals.map((a) => a.id)).toEqual(['a2']);
      expect(run([{ type: 'APPROVAL_REMOVED', id: 'nope' }], s1).approvals).toHaveLength(2);
      expect(run([{ type: 'APPROVALS_SET', items: [approval('z')] }], s1).approvals.map((a) => a.id)).toEqual(['z']);
    });
  });

  describe('确认竞态：用户点确认与 worker 推进几乎同时发生', () => {
    it('无论 job / stage / snapshot 以什么顺序到达，最终状态都以最后一次权威信息为准', () => {
      const events: RunAction[] = [
        { type: 'STAGE', stage: 'requirement', status: 'done', result: { prd: 1 } },
        { type: 'STAGE', stage: 'requirement', status: 'waiting_confirm' },
        { type: 'JOB', status: 'waiting_confirm' },
        // 用户确认后，服务端推进到下一阶段
        { type: 'JOB', status: 'running' },
        { type: 'STAGE', stage: 'prototype', status: 'running' },
      ];
      const s = run(events, run([{ type: 'SNAPSHOT', doc: doc() }]));
      expect(s.doc!.status).toBe('running');
      expect(s.doc!.stages.prototype.status).toBe('running');
      expect(s.doc!.stages.requirement.result).toEqual({ prd: 1 });
      // 迟到的旧快照（version 更小）不会被特殊处理——快照就是权威，由服务端保证它不会倒退
      const late = run([{ type: 'SNAPSHOT', doc: doc({ version: 99, status: 'waiting_confirm', currentStage: 'prototype' }) }], s);
      expect(late.doc!.status).toBe('waiting_confirm');
    });
  });
});
