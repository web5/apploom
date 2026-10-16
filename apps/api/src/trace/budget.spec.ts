import { assertWithinBudget, DEFAULT_TOKEN_BUDGET, pipelineTokenBudget, sumUsage, totalTokens } from './budget';

describe('token 预算', () => {
  afterEach(() => delete process.env.PIPELINE_TOKEN_BUDGET);

  it('默认 50 万；0 表示不限制；非法值回退默认', () => {
    expect(pipelineTokenBudget()).toBe(DEFAULT_TOKEN_BUDGET);
    process.env.PIPELINE_TOKEN_BUDGET = '1000';
    expect(pipelineTokenBudget()).toBe(1000);
    process.env.PIPELINE_TOKEN_BUDGET = '0';
    expect(pipelineTokenBudget()).toBe(0);
    process.env.PIPELINE_TOKEN_BUDGET = 'abc';
    expect(pipelineTokenBudget()).toBe(DEFAULT_TOKEN_BUDGET);
  });

  it('用量达到上限抛 budget 类错误；未达上限或不限制时放行', () => {
    expect(() => assertWithinBudget(99, 100)).not.toThrow();
    expect(() => assertWithinBudget(10_000_000, 0)).not.toThrow();
    try {
      assertWithinBudget(100, 100);
      throw new Error('应当抛出');
    } catch (e) {
      expect((e as { errorClass?: string }).errorClass).toBe('budget');
      expect((e as Error).message).toContain('PIPELINE_TOKEN_BUDGET');
    }
  });

  it('sumUsage 汇总并传递 estimated 标记', () => {
    const u = sumUsage([
      { usage: { promptTokens: 1, completionTokens: 2 } },
      { usage: { promptTokens: 10, completionTokens: 20, estimated: true } },
    ]);
    expect(u).toEqual({ promptTokens: 11, completionTokens: 22, estimated: true });
    expect(totalTokens(u)).toBe(33);
  });
});
