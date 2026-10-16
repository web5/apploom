import { stageNode } from '@apploom/shared';
import { runAgent } from './agent-runner';
import { CODEGEN_SPEC, DESIGN_SPEC, PROTOTYPE_SPEC, REQUIREMENT_SPEC } from './agent-specs';
import { scriptedChat } from './fake-model';

const PRD = {
  overview: '计数器', targetUsers: ['个人'], features: [{ id: 'F1', name: '计数', priority: 'P0', desc: '加减' }],
  userStories: ['As a user'], pages: ['home'], entities: [], assumptions: ['纯前端'],
};
const html = '<html>' + 'x'.repeat(200) + '</html>';
const PROTO = { appName: 'A', designStyle: '简约', html, pages: [{ id: 'home', title: '首页' }], flows: [{ name: '计数', description: '点击加一' }] };
const CODEGEN = { files: [{ path: 'a.ts', content: 'x' }], dependencies: ['react@^18'], runCommand: 'npm run dev', notes: [] };

beforeAll(() => {
  process.env.LLM_PROVIDER = 'deepseek';
  process.env.DEEPSEEK_API_KEY = 'test-key';
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

const ctx = (chatFn: ReturnType<typeof scriptedChat>, over = {}) => ({ onToken: jest.fn(), chatFn, ...over });

describe('runAgent：基本路径', () => {
  it('成功：解析、摘要，并把 prompt / 温度（取自 STAGE_GRAPH）/ schema / 流式参数交给模型', async () => {
    const chat = scriptedChat([{ content: JSON.stringify(PRD) }]);
    const c = ctx(chat);
    const r = await runAgent(REQUIREMENT_SPEC, '做个计数器', c);

    expect(r.error).toBeUndefined();
    expect(r.doc).toEqual(PRD);
    expect(r.summary).toEqual({ features: 1, p0: 1, assumptions: 1, entities: 0, warnings: [] });
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]).toMatchObject({
      label: 'generatePrd',
      user: '用户需求：\n做个计数器',
      temperature: stageNode('requirement').temperature,
      stream: true,
      jsonSchema: { name: 'PRD' },
    });
    expect(chat.calls[0].maxTokens).toBeUndefined();
    expect(c.onToken).toHaveBeenCalledWith(JSON.stringify(PRD));
  });

  it('带修复反馈：追加到 user prompt；截断自愈级别放大 maxTokens（以阶段默认值为基数、封顶）', async () => {
    const chat = scriptedChat([{ content: JSON.stringify(CODEGEN) }]);
    await runAgent(CODEGEN_SPEC, { design: {}, prototype: PROTO }, ctx(chat, { repair: { feedback: '精简些', previousError: '被截断', maxTokensLevel: 1 } }));
    expect(chat.calls[0].user).toContain('# 修改要求（重要）');
    expect(chat.calls[0].user).toContain('反馈：精简些');
    expect(chat.calls[0].user).toContain('上次失败原因：\n被截断');
    expect(chat.calls[0].maxTokens).toBe(16384); // 8192 × 2，未超默认封顶 16384

    const capped = scriptedChat([{ content: JSON.stringify(CODEGEN) }]);
    process.env.LLM_MAX_TOKENS_CEILING = '8192';
    await runAgent(CODEGEN_SPEC, { design: {}, prototype: PROTO }, ctx(capped, { repair: { feedback: 'x', maxTokensLevel: 3 } }));
    delete process.env.LLM_MAX_TOKENS_CEILING;
    expect(capped.calls[0].maxTokens).toBe(8192);
  });

  it('上游怎么渲染进 prompt 由各阶段声明：design 拿到的是去掉 html 的原型', async () => {
    const chat = scriptedChat([{ content: '{}' }]);
    await runAgent(DESIGN_SPEC, { prd: PRD, prototype: PROTO }, ctx(chat));
    expect(chat.calls[0].user).toContain('上游 PRD');
    expect(chat.calls[0].user).not.toContain('x'.repeat(200));
  });
});

describe('runAgent：解析失败的处理', () => {
  it('JSON 合法但不符合 schema：报 Zod 原因，不做本地修复也不重问', async () => {
    const chat = scriptedChat([{ content: JSON.stringify({ ...PRD, features: 'oops' }) }]);
    const r = await runAgent(REQUIREMENT_SPEC, 'x', ctx(chat));
    expect(r.doc).toBeUndefined();
    expect(r.error).toContain('features');
    expect(r.errorClass).toBeUndefined();
    expect(chat.calls).toHaveLength(1);
  });

  it('finish_reason=length：归为 truncated，且不重问（重问只会再被截断）', async () => {
    const chat = scriptedChat([{ content: '{"appName":"A","html":"<div', finishReason: 'length' }]);
    const r = await runAgent(PROTOTYPE_SPEC, PRD, ctx(chat));
    expect(r.errorClass).toBe('truncated');
    expect(chat.calls).toHaveLength(1);
  });

  it('模型正常结束（stop）却输出垃圾：不冒充截断', async () => {
    const chat = scriptedChat([{ content: 'garbage', finishReason: 'stop' }]);
    const r = await runAgent(DESIGN_SPEC, { prd: PRD, prototype: PROTO }, ctx(chat));
    expect(r.errorClass).toBeUndefined();
    expect(r.error).not.toContain('截断');
  });

  it('所有阶段都能本地修复反斜杠非法转义（不只是原型）：raw 换成修复后的 JSON，并带告警', async () => {
    const bad = JSON.stringify(PRD).replace('"计数器"', '"计数\\.器"'); // 注入非法转义 \.
    expect(() => JSON.parse(bad)).toThrow();
    const chat = scriptedChat([{ content: bad }]);
    const r = await runAgent(REQUIREMENT_SPEC, 'x', ctx(chat));
    expect(r.error).toBeUndefined();
    expect(r.doc?.overview).toBe('计数\\.器');
    expect(r.summary?.warnings[0]).toContain('本地 JSON 修复');
    expect(() => JSON.parse(r.raw)).not.toThrow();
    expect(chat.calls).toHaveLength(1);
  });
});

describe('runAgent：原型阶段的「带错误反馈重问一次」', () => {
  const garbage = { content: '这不是 JSON' };

  it('首次解析失败 → 重问一次成功：label 带 -retry，prompt 含反馈与上次原文，上限固定 8192', async () => {
    const chat = scriptedChat([garbage, { content: JSON.stringify(PROTO) }]);
    const r = await runAgent(PROTOTYPE_SPEC, PRD, ctx(chat));
    expect(r.error).toBeUndefined();
    expect(r.summary?.warnings[0]).toBe('已通过 LLM 重新生成成功（上次 JSON 解析失败）');
    expect(chat.calls.map((c) => c.label)).toEqual(['generatePrototype', 'generatePrototype-retry']);
    expect(chat.calls[1].user).toContain('反斜杠都必须双重转义');
    expect(chat.calls[1].user).toContain('这不是 JSON');
    expect(chat.calls[1].maxTokens).toBe(8192);
  });

  it('重问的输出带非法转义：本地修复兜底，告警说明两层都用上了', async () => {
    const bad = JSON.stringify(PROTO).replace('"简约"', '"简\\!约"');
    const chat = scriptedChat([garbage, { content: bad }]);
    const r = await runAgent(PROTOTYPE_SPEC, PRD, ctx(chat));
    expect(r.error).toBeUndefined();
    expect(r.summary?.warnings[0]).toBe('已通过 LLM 重新生成 + 本地 JSON 修复恢复');
  });

  it('重问仍失败：报「重试后仍失败」，raw 保留首次原文', async () => {
    const chat = scriptedChat([garbage]);
    const r = await runAgent(PROTOTYPE_SPEC, PRD, ctx(chat));
    expect(chat.calls).toHaveLength(2);
    expect(r.error).toContain('JSON 解析失败（重试后仍失败）');
    expect(r.raw).toBe('这不是 JSON');
  });

  it('重问本身被截断：保留 truncated 类别，流水线才能据此放大上限', async () => {
    const chat = scriptedChat([garbage, { content: '{"appName":"A","html":"<div', finishReason: 'length' }]);
    const r = await runAgent(PROTOTYPE_SPEC, PRD, ctx(chat));
    expect(r.errorClass).toBe('truncated');
  });

  it('已经处在修复 / 重试之中（带 repair）就不再重问，避免套娃', async () => {
    const chat = scriptedChat([garbage]);
    const r = await runAgent(PROTOTYPE_SPEC, PRD, ctx(chat, { repair: { feedback: '改改' } }));
    expect(chat.calls).toHaveLength(1);
    expect(r.error).toContain('JSON 解析失败（原始错误');
  });

  it('只有原型阶段声明了重问；其它阶段解析失败不会多调一次模型', async () => {
    const chat = scriptedChat([garbage]);
    await runAgent(CODEGEN_SPEC, { design: {}, prototype: PROTO }, ctx(chat));
    expect(chat.calls).toHaveLength(1);
  });
});
