import type { LLMProviderConfig } from './providers';

export interface ChatOptions {
  /** 调用方标识（如 'generateDeploy'），日志里显示 */
  label?: string;
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** 流式输出：边生成边回调 token */
  stream?: boolean;
  onToken?: (token: string) => void;
  /** 结构化输出：传 JSON Schema，网关会尝试用 response_format 约束 */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface ChatResult {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * 最小 LLM 网关：OpenAI 兼容 /chat/completions
 * - 支持流式（SSE）与非流式
 * - 支持结构化输出（json_schema 或 json_object 回退）
 */
export async function chat(config: LLMProviderConfig, options: ChatOptions): Promise<ChatResult> {
  const tag = options.label ? `[LLM:${options.label}]` : '[LLM]';

  // —— 请求侧日志（便于调试 prompt / 反馈是否正确传入）——
  // 截断避免超长污染终端，但保留完整可追溯性
  const trunc = (s: string, n = 800) => (s.length > n ? `${s.slice(0, n)}…(+${s.length - n} chars)` : s);
  console.error(`${tag} → model=${config.model} temp=${options.temperature ?? 0.7} stream=${!!options.stream}${options.jsonSchema ? ` schema=${options.jsonSchema.name}` : ''}`);
  console.error(`${tag} → system: ${trunc(options.system ?? '(none)', 500)}`);
  console.error(`${tag} → user: ${trunc(options.user, 1500)}`);

  const messages: Array<{ role: string; content: string }> = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: options.user });

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: options.temperature ?? 0.7,
    stream: !!options.stream,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;

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

  const url = `${config.baseURL.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM 请求失败 ${res.status}: ${text}`);
  }

  // 流式
  if (options.stream && options.onToken) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
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
          const delta: string | undefined = json.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            options.onToken(delta);
          }
        } catch {
          // 忽略不完整分片
        }
      }
    }
    console.error(`${tag} ← stream done, total=${content.length} chars: ${trunc(content, 600)}`);
    return { content };
  }

  // 非流式
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const resultContent = json.choices?.[0]?.message?.content ?? '';
  console.error(`${tag} ← ${resultContent.length} chars: ${trunc(resultContent, 600)}`);
  return {
    content: resultContent,
    usage: json.usage
      ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 }
      : undefined,
  };
}
