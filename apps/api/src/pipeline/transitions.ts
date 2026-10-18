/**
 * 流水线文档的状态转移：全是纯函数，不碰 Redis / 队列 / 事件总线，因此可以直接用内存里的文档做表驱动测试。
 *
 * 约定（由测试保证）：
 *  - 函数就地修改传入的 doc（PipelineStore.mutate 会在原子快照上调用它们）
 *  - 返回 null / false 表示「守卫拒绝」，此时**一个字节都不能改**（store 据此跳过写入、不涨 version）
 *  - 守卫判断用的是传入 doc 的当前内容，所以必须在 mutate 的闭包里调用，不能先读后调
 */
import { downstreamOf, nextStageOf } from '@apploom/shared';
import type { ErrorClass, LlmLogEntry, PipelineDoc, PipelineStage } from './pipeline.types';
import { PIPELINE_STAGES } from './pipeline.types';

// ───────────────────────── 用户命令：confirm / retry / repair ─────────────────────────

export type ConfirmOutcome = { kind: 'completed' } | { kind: 'advance'; next: PipelineStage };

/** 确认当前等待的阶段：推进到下一阶段，或（之后的阶段都已完成时）直接收尾 */
export function applyConfirm(d: PipelineDoc, stage: PipelineStage): ConfirmOutcome | null {
  const next = nextStageOf(stage);
  if (d.status !== 'waiting_confirm' || d.currentStage !== stage || !next) return null;
  // 异常链路兜底：若当前阶段之后全部已完成（如重试产生的手工状态），直接收尾为 completed
  const stageIdx = PIPELINE_STAGES.indexOf(stage);
  const allAfterDone = PIPELINE_STAGES.every((s, i) => i <= stageIdx || d.stages[s].status === 'done');
  if (allAfterDone) {
    d.status = 'completed';
    d.currentStage = null;
    return { kind: 'completed' };
  }
  d.status = 'running';
  d.currentStage = next;
  return { kind: 'advance', next };
}

/** 失败重试：把 failed 阶段重置为 pending，其余已产出保留。返回要重跑的阶段 */
export function applyRetry(d: PipelineDoc, stage?: PipelineStage): PipelineStage | null {
  // 允许重试「failed」阶段；崩溃残留的「running」阶段（BullMQ 已标 failed）也可重试
  const target = stage ?? PIPELINE_STAGES.find((s) => d.stages[s].status === 'failed' || d.stages[s].status === 'running');
  if (!target || (d.status !== 'failed' && d.status !== 'running')) return null;
  const st = d.stages[target];
  st.status = 'pending';
  st.error = undefined;
  st.result = undefined;
  st.raw = undefined;
  d.handoffs[target] = false;
  d.status = 'running';
  d.currentStage = target;
  return target;
}

/**
 * 带反馈重新生成某个阶段。feedback 显式传入 = 手动修复（可为空串 = 无反馈重跑）；省略 = 自动修复，用上次 error 作反馈。
 * 把当前 result / error 归档到 history 供模型参考，并让所有依赖它的下游阶段作废、等待重跑。
 */
export function applyRepair(d: PipelineDoc, stage: PipelineStage, feedback?: string): boolean {
  const st = d.stages[stage];
  if (!st) return false;
  const isAuto = feedback === undefined;
  const effectiveFeedback = isAuto ? st.error : (feedback ?? '').trim();
  // 自动修复必须有 error 才能修；手动重跑允许空反馈
  if (isAuto && !effectiveFeedback) return false;

  if (!st.history) st.history = [];
  st.history.push({ result: st.result, error: st.error });
  // 有反馈才保存；空反馈 = 无反馈重跑（buildRepair 因空串返回 undefined）
  if (effectiveFeedback) st.feedback = effectiveFeedback;
  else delete st.feedback;
  resetStage(st);
  d.handoffs[stage] = false;
  // 下游阶段要重新跑（上游变了，下游产出作废）。由图推导，不是按位置猜
  for (const s of downstreamOf(stage)) {
    if (d.stages[s].status === 'done' || d.stages[s].status === 'failed') {
      resetStage(d.stages[s]);
      d.stages[s].status = 'pending';
    }
    d.handoffs[s] = false;
  }
  d.status = 'running';
  d.currentStage = stage;
  return true;
}

function resetStage(st: PipelineDoc['stages'][PipelineStage]): void {
  st.status = 'pending';
  st.result = undefined;
  st.raw = undefined;
  st.error = undefined;
  st.summary = undefined;
}

// ───────────────────────── worker：一次阶段执行的生命周期 ─────────────────────────

/** 该阶段仍处于「我这次执行」：正在运行且 attempts 未被后续执行改动 */
export function isCurrentRun(d: PipelineDoc, stage: PipelineStage, attempt: number): boolean {
  return d.stages[stage].status === 'running' && d.stages[stage].attempts === attempt;
}

/** 该阶段的完成态仍是「我这次执行」产出的 */
export function isCurrentDone(d: PipelineDoc, stage: PipelineStage, attempt: number): boolean {
  return d.stages[stage].status === 'done' && d.stages[stage].attempts === attempt;
}

/** 开始执行：返回本次执行的身份（attempts 自增后的值），之后所有写入都要用它校验 */
export function applyStageStart(d: PipelineDoc, stage: PipelineStage): number {
  d.status = 'running';
  d.currentStage = stage;
  const st = d.stages[stage];
  st.status = 'running';
  st.error = undefined;
  st.errorClass = undefined;
  st.startedAt = new Date().toISOString();
  st.attempts += 1;
  return st.attempts;
}

export interface StageFailureInfo {
  message: string;
  errorClass: ErrorClass;
  /** 失败时仍保留 result / raw（如 deploy 已执行但失败，需保留日志供诊断） */
  keepResult?: boolean;
}

export interface StageProduct {
  result?: unknown;
  raw?: string;
  summary?: unknown;
}

/** 执行失败。已被修复 / 重试取代的旧执行返回 false，不覆盖新状态 */
export function applyStageFailure(d: PipelineDoc, stage: PipelineStage, attempt: number, failure: StageFailureInfo, logs: LlmLogEntry[], product?: StageProduct): boolean {
  if (!isCurrentRun(d, stage, attempt)) return false;
  const st = d.stages[stage];
  d.status = 'failed';
  st.status = 'failed';
  st.error = failure.message;
  st.errorClass = failure.errorClass;
  st.llmLogs = logs;
  st.finishedAt = new Date().toISOString();
  if (failure.keepResult && product) {
    st.result = product.result;
    st.raw = product.raw;
    st.summary = product.summary;
  }
  return true;
}

/** 执行成功。已被取代的旧执行返回 false */
export function applyStageSuccess(d: PipelineDoc, stage: PipelineStage, attempt: number, product: StageProduct, logs: LlmLogEntry[]): boolean {
  if (!isCurrentRun(d, stage, attempt)) return false;
  const st = d.stages[stage];
  st.status = 'done';
  st.result = product.result;
  st.raw = product.raw;
  st.summary = product.summary;
  st.llmLogs = logs;
  st.finishedAt = new Date().toISOString();
  return true;
}

export type HandoffKind = 'wait' | 'advance' | 'complete';

/**
 * 交接：wait = 逐步确认模式挂起等人；advance = 自动模式，调用方随后入队下一阶段；complete = 最后阶段完成，整条流水线收尾。
 * 要求本次执行仍是当前这次（done 且 attempts 未变），否则说明已被修复 / 重试取代，不能代它交接。
 */
export function applyHandoff(d: PipelineDoc, stage: PipelineStage, attempt: number, kind: HandoffKind): boolean {
  if (!isCurrentDone(d, stage, attempt)) return false;
  d.handoffs[stage] = true;
  if (kind === 'wait') {
    // 用户可能已确认推进（confirm 已把 currentStage 改成下一阶段）→ 不覆盖
    if (d.status === 'waiting_confirm' || (d.status === 'running' && d.currentStage === stage)) d.status = 'waiting_confirm';
  } else if (kind === 'complete') {
    d.status = 'completed';
    d.currentStage = null;
  }
  return true;
}
