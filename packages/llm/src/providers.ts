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
}

/** LLM_STREAM_USAGE=1/0 可覆盖 provider 默认 */
function streamUsageOr(fallback: boolean): boolean {
  const v = process.env.LLM_STREAM_USAGE;
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
        // deepseek-chat 当前稳定支持 json_object；json_schema 视版本开 supportsJsonSchema
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
        supportsJsonSchema: false,
        streamUsage: streamUsageOr(true),
      };
    case 'hunyuan':
      return {
        baseURL: process.env.HUNYUAN_BASE_URL ?? 'https://tokenhub.tencentmaas.com/v1',
        apiKey,
        // 用户指定的混元模型：hy3（可用 HUNYUAN_MODEL 覆盖）
        model: process.env.HUNYUAN_MODEL ?? 'hy3',
        supportsJsonSchema: false,
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
  return resolveProvider(name, apiKey);
}
