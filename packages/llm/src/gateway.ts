import type { LLMProviderConfig } from './providers';
import { LlmError, classifyError, classifyHttpStatus, retryPolicy, type ErrorClass } from './errors';

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** true = 服务端没返回 usage，按字符数粗略估算 */
  estimated?: boolean;
}

/** 单次 LLM 调用日志（存 doc 供前端调试入口展示，同时是 trace 的最小单元） */
export interface LlmLogEntry {
  label: string;
  ts: string;
  /** user prompt（含 repair 反馈，是调试关键） */
  user: string;
  /** 模型响应原文（失败时为已收到的部分内容） */
  response: string;
  model?: string;
  temperature?: number;
  durationMs?: number;
  usage?: LlmUsage;
  /** 模型停止原因；'length' 表示被 max_tokens 截断 */
  finishReason?: string;
  /** 第几次尝试（0 = 首次，>0 = 网关自动重试） */
  attempt?: number;
  /** 本次调用失败时的错误类别与信息 */
  errorClass?: ErrorClass;
  error?: string;
  /** 本次调用由备用模型完成时，记录切换原因 */
  fallbackReason?: string;
}

export interface ChatOptions {
  /** 调用方标识（如 'generateDeploy'），日志里显示 */
  label?: string;
  /** 日志回调：每次调用完成（成功或失败）后回传 */
  onLog?: (entry: LlmLogEntry) => void;
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** 流式输出：边生成边回调 token */
  stream?: boolean;
  onToken?: (token: string) => void;
  /** 结构化输出：传 JSON Schema，网关会尝试用 response_format 约束 */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** 单次请求超时毫秒，默认 LLM_TIMEOUT_MS 或 300000 */
  timeoutMs?: number;
  /** transient 错误的最大自动重试次数，默认 LLM_MAX_RETRIES 或 2 */
  maxRetries?: number;
}

export interface ChatResult {
  content: string;
  usage?: LlmUsage;
  finishReason?: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 没有服务端 usage 时的粗略估算（中英混合约 3 字符 / token） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 最小 LLM 网关：OpenAI 兼容 /chat/completions
 * - 支持流式（SSE）与非流式
 * - 支持结构化输出（json_schema 或 json_object 回退）
 * - 请求超时；transient 错误指数退避重试（流式已开始输出后不重试，避免重复推送）
 * - 失败抛 LlmError（带错误类别）
 */
export async function chat(config: LLMProviderConfig, options: ChatOptions): Promise<ChatResult> {
  let emitted = false;
  const wrapped: ChatOptions = {
    ...options,
    onToken: options.onToken
      ? (t) => {
          emitted = true;
          options.onToken!(t);
        }
      : undefined,
  };

  try {
    return await chatWithRetries(config, wrapped, () => emitted);
  } catch (e) {
    // 主模型 transient 错误重试耗尽 → 切备用模型（已向调用方推送过 token 则不切，避免内容重复）
    if (config.fallback && classifyError(e) === 'transient' && !emitted) {
      const reason = `主模型 ${config.model} 不可用，已切换备用模型 ${config.fallback.model}: ${(e as Error).message}`;
      console.error(`[LLM:${options.label ?? ''}] ${reason}`);
      return chatWithRetries(
        config.fallback,
        { ...wrapped, onLog: (entry) => options.onLog?.({ ...entry, fallbackReason: reason }) },
        () => emitted,
      );
    }
    throw e;
  }
}

async function chatWithRetries(config: LLMProviderConfig, options: ChatOptions, hasEmitted: () => boolean): Promise<ChatResult> {
  const policy = retryPolicy('transient');
  const maxRetries = options.maxRetries ?? envInt('LLM_MAX_RETRIES', policy.retries);

  for (let attempt = 0; ; attempt++) {
    try {
      return await chatOnce(config, options, attempt);
    } catch (e) {
      if (classifyError(e) === 'transient' && !hasEmitted() && attempt < maxRetries) {
        const wait = policy.backoffMs * 2 ** attempt + Math.floor(Math.random() * 250);
        console.error(`[LLM:${options.label ?? ''}] transient 错误，${wait}ms 后重试（${attempt + 1}/${maxRetries}）: ${(e as Error).message}`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

async function chatOnce(config: LLMProviderConfig, options: ChatOptions, attempt: number): Promise<ChatResult> {
  const tag = options.label ? `[LLM:${options.label}]` : '[LLM]';
  const label = options.label ?? 'llm';
  const timeoutMs = options.timeoutMs ?? envInt('LLM_TIMEOUT_MS', 300_000);
  const started = Date.now();

  // —— 请求侧日志（便于调试 prompt / 反馈是否正确传入）——
  const trunc = (s: string, n = 800) => (s.length > n ? `${s.slice(0, n)}…(+${s.length - n} chars)` : s);
  console.error(`${tag} → model=${config.model} temp=${options.temperature ?? 0.7} stream=${!!options.stream}${options.jsonSchema ? ` schema=${options.jsonSchema.name}` : ''}${attempt ? ` attempt=${attempt}` : ''}`);
  console.error(`${tag} → system: ${trunc(options.system ?? '(none)', 500)}`);
  console.error(`${tag} → user: ${trunc(options.user, 1500)}`);

  const messages: Array<{ role: string; content: string }> = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: options.user });

  const body: Record<string, unknown> = {
    ...config.extraBody,
    model: config.model,
    messages,
    temperature: options.temperature ?? 0.7,
    stream: !!options.stream,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.stream && config.streamUsage) body.stream_options = { include_usage: true };

  if (options.jsonSchema) {
    if (config.supportsJsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: options.jsonSchema.name, schema: options.jsonSchema.schema, strict: true },
      };
    } else {
      // 广泛兼容：json_object + prompt 内约束，后续用 Zod 二次校验
      body.response_format = { type: 'json_object' };
    }
  }

  const promptText = `${options.system ?? ''}${options.user}`;
  let content = '';
  let usage: LlmUsage | undefined;
  let finishReason: string | undefined;

  const emitLog = (extra: Partial<LlmLogEntry> = {}) =>
    options.onLog?.({
      label,
      ts: new Date().toISOString(),
      user: options.user,
      response: content,
      model: config.model,
      temperature: options.temperature ?? 0.7,
      durationMs: Date.now() - started,
      usage: usage ?? { promptTokens: estimateTokens(promptText), completionTokens: estimateTokens(content), estimated: true },
      finishReason,
      attempt,
      ...extra,
    });

  try {
    const url = `${config.baseURL.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new LlmError(`LLM 请求失败 ${res.status}: ${text}`, classifyHttpStatus(res.status), res.status);
    }

    if (options.stream && options.onToken) {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const choice = json.choices?.[0];
            const delta: string | undefined = choice?.delta?.content;
            if (delta) {
              content += delta;
              options.onToken(delta);
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (json.usage) {
              usage = { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 };
            }
          } catch {
            // 忽略不完整分片
          }
        }
      }
      console.error(`${tag} ← stream done, total=${content.length} chars finish=${finishReason ?? '?'}: ${trunc(content, 600)}`);
      emitLog();
      return { content, usage, finishReason };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    content = json.choices?.[0]?.message?.content ?? '';
    finishReason = json.choices?.[0]?.finish_reason;
    if (json.usage) {
      usage = { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 };
    }
    console.error(`${tag} ← ${content.length} chars finish=${finishReason ?? '?'}: ${trunc(content, 600)}`);
    emitLog();
    return { content, usage, finishReason };
  } catch (e) {
    const errorClass = classifyError(e);
    emitLog({ errorClass, error: (e as Error).message });
    if (e instanceof LlmError) throw e;
    const friendly = (e as Error).name === 'TimeoutError' ? `LLM 请求超时（${timeoutMs / 1000}s）` : `LLM 请求异常: ${(e as Error).message}`;
    throw new LlmError(friendly, errorClass, undefined, { cause: e });
  }
}
