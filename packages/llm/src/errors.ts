/**
 * 错误分类 —— 每一类对应一种恢复行为，不用一个重试策略通吃。
 *
 *  transient      超时 / 429 / 5xx / 网络错误        → 指数退避重试
 *  invalid_input  请求参数不合法（4xx）              → 不重试
 *  invalid_output 模型输出不符合契约（JSON/Zod 失败） → 不盲目重试，把校验错误回喂模型
 *  truncated      输出被 max_tokens 截断（finish_reason=length） → 原样重试必然再截断：放大上限 + 要求精简后重生成
 *  permission     鉴权失败 / 权限不足（401/403）      → 不重试，需要人处理
 *  not_found      模型或资源不存在（404）            → 不重试
 *  budget         超出预算 / 服务商额度用完（402）    → 终止，需人处理
 *  verification   确定性门禁未通过（如 codegen 门禁） → 已内部修复过，不再重试
 *  execution      本地执行失败（如部署 install）      → 不自动重试，交给人
 *  unknown        其它                               → 记录并终止
 */
export type ErrorClass =
  | 'transient'
  | 'invalid_input'
  | 'invalid_output'
  | 'truncated'
  | 'permission'
  | 'not_found'
  | 'budget'
  | 'verification'
  | 'execution'
  | 'unknown';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}

export function classifyHttpStatus(status: number): ErrorClass {
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return 'transient';
  if (status === 401 || status === 403) return 'permission';
  // 402：服务商额度用完 / 欠费。重试和换提示词都没用，必须由人充值或换模型，按预算类处理（终止）
  if (status === 402) return 'budget';
  if (status === 404) return 'not_found';
  if (status >= 400) return 'invalid_input';
  return 'unknown';
}

/** 归类任意异常：LlmError 取其类别；fetch 网络错误 / 超时视为 transient */
export function classifyError(e: unknown): ErrorClass {
  const cls = (e as { errorClass?: ErrorClass } | null)?.errorClass;
  if (cls) return cls;
  const err = e as { name?: string; message?: string; cause?: { code?: string } } | null;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'transient';
  if (err?.name === 'TypeError' && /fetch failed|network/i.test(err.message ?? '')) return 'transient';
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(err?.cause?.code ?? '')) return 'transient';
  return 'unknown';
}

export interface RetryPolicy {
  /** 自动重试次数（不含首次） */
  retries: number;
  /** 首次退避毫秒，之后指数增长 */
  backoffMs: number;
  /** 是否应把错误回喂给模型让它自己修正 */
  feedbackToModel: boolean;
}

export function retryPolicy(c: ErrorClass): RetryPolicy {
  switch (c) {
    case 'transient':
      return { retries: 2, backoffMs: 1000, feedbackToModel: false };
    case 'invalid_output':
    case 'truncated':
      return { retries: 0, backoffMs: 0, feedbackToModel: true };
    default:
      return { retries: 0, backoffMs: 0, feedbackToModel: false };
  }
}
