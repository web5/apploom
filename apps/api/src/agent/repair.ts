/** 带反馈重生成上下文：用户修复意见（或自动修复回喂的校验错误）+ 上次产出 / 错误 */
export interface RepairContext {
  feedback: string;
  previous?: unknown;
  previousError?: string;
  /** 截断自愈的放大级别：0/缺省 = 不放大；每被截断一次 +1，输出上限按 2^level 倍放大（见 maxTokensFor） */
  maxTokensLevel?: number;
}

/** 拼装带反馈的 user 提示词后缀 */
export function buildRepairSuffix(repair: RepairContext): string {
  let s = `\n\n# 修改要求（重要）\n请根据以下反馈，修正你上一次的产出并重新输出完整结果：\n反馈：${repair.feedback}`;
  if (repair.previous !== undefined) {
    s += `\n\n上次产出（供参考，请在此基础上修正）：\n${JSON.stringify(repair.previous, null, 2)}`;
  }
  if (repair.previousError) {
    s += `\n\n上次失败原因：\n${repair.previousError}`;
  }
  return s;
}

/** 未显式设置 maxTokens 的阶段，放大时以此为基数（多数服务商的默认输出上限） */
const DEFAULT_OUTPUT_TOKENS = 4096;

/**
 * 截断自愈：被 max_tokens 截断后的重生成按 2^level 倍放大输出上限，封顶 LLM_MAX_TOKENS_CEILING（默认 16384；
 * DeepSeek 官方 API 上限为 8192，使用时请把它设成 8192，否则服务端会以 400 拒绝）。level 为 0 时保持原值。
 */
export function maxTokensFor(base: number | undefined, repair?: RepairContext): number | undefined {
  const level = repair?.maxTokensLevel ?? 0;
  if (level <= 0) return base;
  const configured = Number(process.env.LLM_MAX_TOKENS_CEILING);
  const ceiling = Number.isFinite(configured) && configured > 0 ? configured : 16384;
  const start = base ?? DEFAULT_OUTPUT_TOKENS;
  return Math.max(start, Math.min(ceiling, start * 2 ** level));
}
