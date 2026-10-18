import {
  applyConfirm, applyHandoff, applyRepair, applyRetry, applyStageFailure, applyStageStart, applyStageSuccess, isCurrentDone, isCurrentRun,
} from './transitions';
import { createPipelineDoc, PIPELINE_STAGES, type LlmLogEntry, type PipelineDoc, type PipelineStage } from './pipeline.types';

const logs: LlmLogEntry[] = [{ label: 'x', ts: 't', user: 'u', response: 'r' }];

/** 构造一份处于指定进度的文档：upTo 之前（含）的阶段 done */
function docAt(opts: { doneThrough?: PipelineStage; status?: PipelineDoc['status']; current?: PipelineStage | null; confirmEach?: boolean } = {}): PipelineDoc {
  const d = createPipelineDoc('需求', opts.confirmEach ?? true);
  d.id = 'd1';
  const idx = opts.doneThrough ? PIPELINE_STAGES.indexOf(opts.doneThrough) : -1;
  PIPELINE_STAGES.forEach((s, i) => {
    if (i <= idx) {
      d.stages[s] = { status: 'done', attempts: 1, result: { from: s }, raw: `raw-${s}`, summary: { s } };
      d.handoffs[s] = true;
    }
  });
  d.status = opts.status ?? 'created';
  d.currentStage = opts.current === undefined ? null : opts.current;
  return d;
}

/** 拒绝时必须不改文档 */
function expectUntouched(d: PipelineDoc, fn: () => unknown, expected: unknown) {
  const before = structuredClone(d);
  expect(fn()).toBe(expected);
  expect(d).toEqual(before);
}

describe('applyConfirm', () => {
  it('等待确认的阶段 → 推进到下一阶段', () => {
    const d = docAt({ doneThrough: 'requirement', status: 'waiting_confirm', current: 'requirement' });
    expect(applyConfirm(d, 'requirement')).toEqual({ kind: 'advance', next: 'prototype' });
    expect([d.status, d.currentStage]).toEqual(['running', 'prototype']);
  });

  it('之后的阶段都已完成（手工状态）→ 直接收尾', () => {
    const d = docAt({ doneThrough: 'deploy', status: 'waiting_confirm', current: 'codegen' });
    expect(applyConfirm(d, 'codegen')).toEqual({ kind: 'completed' });
    expect([d.status, d.currentStage]).toEqual(['completed', null]);
  });

  it.each([
    ['状态不是 waiting_confirm', () => docAt({ doneThrough: 'requirement', status: 'running', current: 'requirement' }), 'requirement'],
    ['确认的不是当前阶段', () => docAt({ doneThrough: 'requirement', status: 'waiting_confirm', current: 'requirement' }), 'prototype'],
    ['最后一个阶段没有下一步', () => docAt({ doneThrough: 'deploy', status: 'waiting_confirm', current: 'deploy' }), 'deploy'],
    ['已经确认过（连点第二下）', () => { const d = docAt({ doneThrough: 'requirement', status: 'waiting_confirm', current: 'requirement' }); applyConfirm(d, 'requirement'); return d; }, 'requirement'],
  ] as Array<[string, () => PipelineDoc, PipelineStage]>)('拒绝且不改文档：%s', (_n, make, stage) => {
    const d = make();
    expectUntouched(d, () => applyConfirm(d, stage), null);
  });
});

describe('applyRetry', () => {
  const failedDoc = () => {
    const d = docAt({ doneThrough: 'design', status: 'failed', current: 'codegen' });
    d.stages.codegen = { status: 'failed', attempts: 2, error: 'boom', errorClass: 'verification', result: { half: 1 }, raw: 'r' };
    return d;
  };

  it('不指定阶段：找到 failed 阶段重置，保留其余产出', () => {
    const d = failedDoc();
    expect(applyRetry(d)).toBe('codegen');
    expect(d.stages.codegen).toMatchObject({ status: 'pending', error: undefined, result: undefined, raw: undefined, attempts: 2 });
    expect(d.stages.design.status).toBe('done');
    expect([d.status, d.currentStage, d.handoffs.codegen]).toEqual(['running', 'codegen', false]);
  });

  it('崩溃残留的 running 阶段也可重试', () => {
    const d = docAt({ doneThrough: 'design', status: 'running', current: 'codegen' });
    d.stages.codegen.status = 'running';
    expect(applyRetry(d)).toBe('codegen');
  });

  it.each([
    ['流水线不在 failed / running', () => docAt({ doneThrough: 'design', status: 'waiting_confirm', current: 'design' })],
    ['没有任何失败阶段', () => docAt({ doneThrough: 'design', status: 'failed', current: 'design' })],
    ['已完成', () => docAt({ doneThrough: 'deploy', status: 'completed', current: null })],
  ] as Array<[string, () => PipelineDoc]>)('拒绝且不改文档：%s', (_n, make) => {
    const d = make();
    expectUntouched(d, () => applyRetry(d), null);
  });
});

describe('applyRepair', () => {
  it('手动修复：归档上次产出、写入反馈、重置本阶段，并让所有下游作废（由图推导）', () => {
    const d = docAt({ doneThrough: 'codegen', status: 'waiting_confirm', current: 'codegen' });
    expect(applyRepair(d, 'prototype', '换成深色主题')).toBe(true);
    expect(d.stages.prototype).toMatchObject({ status: 'pending', feedback: '换成深色主题', result: undefined });
    expect(d.stages.prototype.history).toEqual([{ result: { from: 'prototype' }, error: undefined }]);
    // prototype 的下游：design / codegen / deploy 作废；requirement 不受影响
    expect(PIPELINE_STAGES.map((s) => d.stages[s].status)).toEqual(['done', 'pending', 'pending', 'pending', 'pending']);
    expect(PIPELINE_STAGES.map((s) => d.handoffs[s])).toEqual([true, false, false, false, false]);
    expect([d.status, d.currentStage]).toEqual(['running', 'prototype']);
  });

  it('空反馈 = 无反馈重跑：不留旧 feedback', () => {
    const d = docAt({ doneThrough: 'requirement', status: 'waiting_confirm', current: 'requirement' });
    d.stages.requirement.feedback = '旧反馈';
    expect(applyRepair(d, 'requirement', '  ')).toBe(true);
    expect(d.stages.requirement.feedback).toBeUndefined();
  });

  it('自动修复（不传 feedback）用上次 error 作反馈', () => {
    const d = docAt({ doneThrough: 'design', status: 'failed', current: 'codegen' });
    d.stages.codegen = { status: 'failed', attempts: 1, error: '门禁未通过' };
    expect(applyRepair(d, 'codegen')).toBe(true);
    expect(d.stages.codegen.feedback).toBe('门禁未通过');
  });

  it('自动修复没有 error 可用 → 拒绝且不改文档', () => {
    const d = docAt({ doneThrough: 'design', status: 'waiting_confirm', current: 'design' });
    expectUntouched(d, () => applyRepair(d, 'design'), false);
  });

  it('修复最后一个阶段：没有下游，只重置自己', () => {
    const d = docAt({ doneThrough: 'deploy', status: 'completed', current: null });
    applyRepair(d, 'deploy', '换个端口');
    expect(PIPELINE_STAGES.map((s) => d.stages[s].status)).toEqual(['done', 'done', 'done', 'done', 'pending']);
  });
});

describe('worker 一次执行的生命周期', () => {
  it('start → success → handoff(wait)：身份贯穿始终', () => {
    const d = docAt({ doneThrough: 'requirement', status: 'running', current: 'prototype' });
    const attempt = applyStageStart(d, 'prototype');
    expect(attempt).toBe(1);
    expect(isCurrentRun(d, 'prototype', attempt)).toBe(true);
    expect(applyStageSuccess(d, 'prototype', attempt, { result: { ok: 1 }, raw: 'r', summary: { n: 1 } }, logs)).toBe(true);
    expect(d.stages.prototype).toMatchObject({ status: 'done', result: { ok: 1 }, llmLogs: logs });
    expect(isCurrentDone(d, 'prototype', attempt)).toBe(true);
    expect(applyHandoff(d, 'prototype', attempt, 'wait')).toBe(true);
    expect(d.handoffs.prototype).toBe(true);
  });

  it('失败：记录类别与日志；keepResult 时保留产出供诊断', () => {
    const d = docAt({ doneThrough: 'codegen', status: 'running', current: 'deploy' });
    const attempt = applyStageStart(d, 'deploy');
    applyStageFailure(d, 'deploy', attempt, { message: 'install 失败', errorClass: 'execution', keepResult: true }, logs, { result: { status: 'failed' }, raw: 'log', summary: {} });
    expect(d.stages.deploy).toMatchObject({ status: 'failed', errorClass: 'execution', result: { status: 'failed' }, raw: 'log' });
    expect(d.status).toBe('failed');
  });

  it('被修复取代的旧执行：成功 / 失败 / 交接都返回 false 且不改文档', () => {
    const d = docAt({ doneThrough: 'requirement', status: 'running', current: 'prototype' });
    const oldAttempt = applyStageStart(d, 'prototype');
    applyRepair(d, 'prototype', '重来'); // 用户在运行期间点了修改 → prototype 回到 pending
    const snapshot = structuredClone(d);
    expect(applyStageSuccess(d, 'prototype', oldAttempt, { result: { stale: true } }, logs)).toBe(false);
    expect(applyStageFailure(d, 'prototype', oldAttempt, { message: 'x', errorClass: 'unknown' }, logs)).toBe(false);
    expect(applyHandoff(d, 'prototype', oldAttempt, 'advance')).toBe(false);
    expect(d).toEqual(snapshot);

    // 修复后的新执行拿到新身份，旧身份仍然无效
    const newAttempt = applyStageStart(d, 'prototype');
    expect(newAttempt).toBe(oldAttempt + 1);
    expect(applyStageSuccess(d, 'prototype', oldAttempt, { result: { stale: true } }, logs)).toBe(false);
    expect(applyStageSuccess(d, 'prototype', newAttempt, { result: { fresh: true } }, logs)).toBe(true);
  });

  it.each([
    ['advance', { status: 'running', handoffs: true, status2: 'running' }],
    ['complete', { status: 'completed', handoffs: true, status2: 'completed' }],
  ] as const)('交接 %s', (kind, expected) => {
    const d = docAt({ doneThrough: 'design', status: 'running', current: 'codegen' });
    d.stages.deploy = { status: 'done', attempts: 1, result: {} };
    expect(applyHandoff(d, 'deploy', 1, kind)).toBe(true);
    expect(d.handoffs.deploy).toBe(expected.handoffs);
    expect(d.status).toBe(expected.status2);
    if (kind === 'complete') expect(d.currentStage).toBeNull();
  });

  it('wait 交接不覆盖用户已经确认推进的状态', () => {
    const d = docAt({ doneThrough: 'requirement', status: 'running', current: 'prototype' }); // confirm 已把 currentStage 推到 prototype
    expect(applyHandoff(d, 'requirement', 1, 'wait')).toBe(true);
    expect([d.status, d.currentStage]).toEqual(['running', 'prototype']);
  });
});
