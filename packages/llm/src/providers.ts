/**
 * LLM Provider 配置。OpenAI 兼容接口，当前支持 DeepSeek 与腾讯混元。
 * 走 OpenAI 兼容的 /chat/completions，所以新增 provider 只需补 baseURL/model。
 */

export interface LLMProviderConfig {
  /** OpenAI 兼容的 base URL（不含末尾 /chat/completions） */
  baseURL: string;
  apiKey: string;
  model: string;
  /** 是否支持 response_format=json_schema（否则回退 json_object） */
  supportsJsonSchema: boolean;
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
      };
    case 'hunyuan':
      return {
        baseURL: process.env.HUNYUAN_BASE_URL ?? 'https://api.hunyuan.cloud.tencent.com/v1',
        apiKey,
        // 用户指定的混元模型：hy3（可用 HUNYUAN_MODEL 覆盖）
        model: process.env.HUNYUAN_MODEL ?? 'hy3',
        supportsJsonSchema: false,
      };
  }
}

/** 从环境变量读取当前 provider（LLM_PROVIDER，默认 deepseek） */
export function loadProviderFromEnv(): LLMProviderConfig {
  const name = (process.env.LLM_PROVIDER as ProviderName) ?? 'deepseek';
  const apiKey = name === 'hunyuan' ? process.env.HUNYUAN_API_KEY : process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      `缺少 API key：请设置 ${name === 'hunyuan' ? 'HUNYUAN_API_KEY' : 'DEEPSEEK_API_KEY'}（可用 .env 或 export）`,
    );
  }
  return resolveProvider(name, apiKey);
}
