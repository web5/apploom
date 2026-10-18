import { resolveProvider } from '@apploom/llm';

describe('resolveProvider 的 json_schema 开关', () => {
  const saved = process.env.LLM_JSON_SCHEMA;
  afterEach(() => {
    if (saved === undefined) delete process.env.LLM_JSON_SCHEMA;
    else process.env.LLM_JSON_SCHEMA = saved;
  });

  it('TokenHub（hunyuan）默认开启 strict json_schema，deepseek 官方默认不开', () => {
    delete process.env.LLM_JSON_SCHEMA;
    expect(resolveProvider('hunyuan', 'k').supportsJsonSchema).toBe(true);
    expect(resolveProvider('deepseek', 'k').supportsJsonSchema).toBe(false);
  });

  it('LLM_JSON_SCHEMA=0/1 可覆盖两者', () => {
    process.env.LLM_JSON_SCHEMA = '0';
    expect(resolveProvider('hunyuan', 'k').supportsJsonSchema).toBe(false);
    process.env.LLM_JSON_SCHEMA = '1';
    expect(resolveProvider('deepseek', 'k').supportsJsonSchema).toBe(true);
  });
});
