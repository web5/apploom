/**
 * LLM Provider 配置。OpenAI 兼容接口，当前支持 DeepSeek 与腾讯混元。
 * 走 OpenAI 兼容的 /chat/completions，所以新增 provider 只需补 baseURL/model。
 */
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LlmError } from './errors';

// 从 cwd 向上查找 .env 并加载（最多 6 级），让 CLI/api 反复调试时不用手动 export
{
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      loadEnv({ path: candidate });
      break;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
}

export interface LLMProviderConfig {
  /** OpenAI 兼容的 base URL（不含末尾 /chat/completions） */
  baseURL: string;
  apiKey: string;
  model: string;
  /** 是否支持 response_format=json_schema（否则回退 json_object） */
  supportsJsonSchema: boolean;
  /** 流式时是否请求 stream_options.include_usage 以拿到真实用量（不支持的服务商会 400，需关闭） */
  streamUsage?: boolean;
  /** 主模型 transient 错误重试耗尽后切换的备用模型（LLM_FALLBACK_PROVIDER；备用自身不再有备用） */
  fallback?: LLMProviderConfig;
  /** 附加请求体字段（LLM_EXTRA_BODY，JSON 对象），如 {"thinking":{"type":"disabled"}} 关闭推理；核心字段（model/messages/stream）不可被覆盖 */
  extraBody?: Record<string, unknown>;
}

/** 解析 LLM_EXTRA_BODY；不是 JSON 对象则告警并忽略（不让一个配置笔误拖垮所有调用） */
export function extraBodyFromEnv(): Record<string, unknown> | undefined {
  const raw = process.env.LLM_EXTRA_BODY;
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // 落到下面的告警
  }
  console.error('[LLM] LLM_EXTRA_BODY 不是合法的 JSON 对象，已忽略');
  return undefined;
}

/** LLM_STREAM_USAGE=1/0 可覆盖 provider 默认 */
function streamUsageOr(fallback: boolean): boolean {
  const v = process.env.LLM_STREAM_USAGE;
  return v === undefined || v === '' ? fallback : v === '1' || v.toLowerCase() === 'true';
}

/** LLM_JSON_SCHEMA=1/0 可覆盖 provider 默认：1 = 发 strict json_schema，0 = 回退 json_object */
function jsonSchemaOr(fallback: boolean): boolean {
  const v = process.env.LLM_JSON_SCHEMA;
  return v === undefined || v === '' ? fallback : v === '1' || v.toLowerCase() === 'true';
}

export type ProviderName = 'deepseek' | 'hunyuan';

/** 预设 provider（环境变量可覆盖 baseURL / model） */
export function resolveProvider(name: ProviderName, apiKey: string): LLMProviderConfig {
  switch (name) {
    case 'deepseek':
      return {
        baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
        apiKey,
        // DeepSeek 官方接口只支持 json_object；LLM_JSON_SCHEMA=1 可在确认服务端支持后强制开启
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
        supportsJsonSchema: jsonSchemaOr(false),
        streamUsage: streamUsageOr(true),
      };
    case 'hunyuan':
      return {
        baseURL: process.env.HUNYUAN_BASE_URL ?? 'https://tokenhub.tencentmaas.com/v1',
        apiKey,
        // 用户指定的混元模型：hy3（可用 HUNYUAN_MODEL 覆盖）
        model: process.env.HUNYUAN_MODEL ?? 'hy3',
        // TokenHub 接受 strict json_schema（5 个阶段 schema 实测均 200）；出问题时 LLM_JSON_SCHEMA=0 回退
        supportsJsonSchema: jsonSchemaOr(true),
        streamUsage: streamUsageOr(false),
      };
  }
}

/** 从环境变量读取当前 provider（LLM_PROVIDER，默认 deepseek） */
export function loadProviderFromEnv(): LLMProviderConfig {
  const name = (process.env.LLM_PROVIDER as ProviderName) ?? 'deepseek';
  const apiKey = name === 'hunyuan' ? process.env.HUNYUAN_API_KEY : process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new LlmError(
      `缺少 API key：请设置 ${name === 'hunyuan' ? 'HUNYUAN_API_KEY' : 'DEEPSEEK_API_KEY'}（可用 .env 或 export）`,
      'permission',
    );
  }
  const primary = resolveProvider(name, apiKey);
  // 附加请求体只作用于主模型：备用模型可能不认这些参数（会 400）
  primary.extraBody = extraBodyFromEnv();

  const fbName = process.env.LLM_FALLBACK_PROVIDER as ProviderName | undefined;
  if (fbName && fbName !== name) {
    const fbKey = fbName === 'hunyuan' ? process.env.HUNYUAN_API_KEY : fbName === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined;
    if (fbKey) primary.fallback = resolveProvider(fbName, fbKey);
    else console.error(`[LLM] LLM_FALLBACK_PROVIDER=${fbName} 无效或缺少对应 API key，已忽略备用模型`);
  }
  return primary;
}
