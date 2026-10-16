/**
 * 流水线 token 预算 —— 以 doc 为单位累计所有阶段、所有执行（含重试/修复/门禁回喂）的用量。
 * 超限抛 budget 类 LlmError：不重试、不自动修复，直接让阶段失败并说明原因。
 *
 * PIPELINE_TOKEN_BUDGET：上限 token 数（prompt + completion），默认 500000；0 = 不限制。
 */
import { LlmError, type LlmUsage } from '@apploom/llm';

export const DEFAULT_TOKEN_BUDGET = 500_000;

export function pipelineTokenBudget(): number {
  const raw = process.env.PIPELINE_TOKEN_BUDGET;
  if (raw === undefined || raw === '') return DEFAULT_TOKEN_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOKEN_BUDGET;
}

export function totalTokens(u: Pick<LlmUsage, 'promptTokens' | 'completionTokens'>): number {
  return u.promptTokens + u.completionTokens;
}

/** 已用量超出预算则抛 budget 错误；budget=0 表示不限制 */
export function assertWithinBudget(usedTokens: number, budget = pipelineTokenBudget()): void {
  if (budget > 0 && usedTokens >= budget) {
    throw new LlmError(
      `流水线 token 预算已用尽：已用 ${usedTokens.toLocaleString('en-US')} / 上限 ${budget.toLocaleString('en-US')}（PIPELINE_TOKEN_BUDGET）。已停止继续调用模型，调高上限后可重试。`,
      'budget',
    );
  }
}

export function sumUsage(records: Array<{ usage: LlmUsage }>): LlmUsage {
  const total: LlmUsage = { promptTokens: 0, completionTokens: 0 };
  for (const r of records) {
    total.promptTokens += r.usage.promptTokens;
    total.completionTokens += r.usage.completionTokens;
    if (r.usage.estimated) total.estimated = true;
  }
  return total;
}
