import { loadProviderFromEnv } from '@apploom/llm';

describe('loadProviderFromEnv 备用模型', () => {
  const keys = ['LLM_PROVIDER', 'LLM_FALLBACK_PROVIDER', 'DEEPSEEK_API_KEY', 'HUNYUAN_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    keys.forEach((k) => (saved[k] = process.env[k]));
    process.env.LLM_PROVIDER = 'deepseek';
    process.env.DEEPSEEK_API_KEY = 'ds';
    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.HUNYUAN_API_KEY;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    keys.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
    jest.restoreAllMocks();
  });

  it('默认不启用备用模型', () => {
    expect(loadProviderFromEnv().fallback).toBeUndefined();
  });

  it('配置了备用 provider 且有 key → 挂在 fallback 上', () => {
    process.env.LLM_FALLBACK_PROVIDER = 'hunyuan';
    process.env.HUNYUAN_API_KEY = 'hy';
    const p = loadProviderFromEnv();
    expect(p.model).toBe('deepseek-chat');
    expect(p.fallback).toMatchObject({ apiKey: 'hy', model: 'hy3' });
    expect(p.fallback?.fallback).toBeUndefined();
  });

  it('备用 provider 缺 key、与主相同或非法 → 忽略', () => {
    process.env.LLM_FALLBACK_PROVIDER = 'hunyuan';
    expect(loadProviderFromEnv().fallback).toBeUndefined();
    process.env.LLM_FALLBACK_PROVIDER = 'deepseek';
    expect(loadProviderFromEnv().fallback).toBeUndefined();
    process.env.LLM_FALLBACK_PROVIDER = 'nope';
    expect(loadProviderFromEnv().fallback).toBeUndefined();
  });

  it('缺主 key 抛 permission 类错误', () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => loadProviderFromEnv()).toThrow(expect.objectContaining({ errorClass: 'permission' }));
  });
});
