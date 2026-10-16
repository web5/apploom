import { STAGE_GRAPH, STAGE_IDS, STAGE_LABEL, downstreamOf, nextStageOf, stageNode, upstreamOf, validateStageGraph, type StageNode } from '@apploom/shared';
import { LlmService } from '../prd/llm.service';

describe('STAGE_GRAPH 当前拓扑（锁定，改动需同步评审）', () => {
  it('阶段顺序与展示名', () => {
    expect([...STAGE_IDS]).toEqual(['requirement', 'prototype', 'design', 'codegen', 'deploy']);
    expect(STAGE_LABEL).toEqual({ requirement: '需求拆解', prototype: '产品原型', design: '方案设计', codegen: '代码生成', deploy: '部署发布' });
  });

  it('各阶段的上游（含 prototype → codegen 跨级边）', () => {
    expect(Object.fromEntries(STAGE_IDS.map((s) => [s, upstreamOf(s)]))).toEqual({
      requirement: [],
      prototype: ['requirement'],
      design: ['requirement', 'prototype'],
      codegen: ['design', 'prototype'],
      deploy: ['codegen'],
    });
  });

  it('级联范围：某阶段变了，哪些阶段产物要作废', () => {
    expect(Object.fromEntries(STAGE_IDS.map((s) => [s, downstreamOf(s)]))).toEqual({
      requirement: ['prototype', 'design', 'codegen', 'deploy'],
      prototype: ['design', 'codegen', 'deploy'],
      design: ['codegen', 'deploy'],
      codegen: ['deploy'],
      deploy: [],
    });
  });

  it('下一阶段与是否需要确认：最后一个阶段之后没有下一个，也无需确认', () => {
    expect(STAGE_IDS.map(nextStageOf)).toEqual(['prototype', 'design', 'codegen', 'deploy', null]);
    expect(STAGE_IDS.map((s) => stageNode(s).needsConfirmation)).toEqual([true, true, true, true, false]);
  });

  it('当前图本身合法', () => {
    expect(validateStageGraph(STAGE_GRAPH)).toEqual([]);
  });
});

describe('validateStageGraph 能拦住的坏图', () => {
  const node = (id: string, from: string[], over: Partial<StageNode> = {}): StageNode => ({
    id,
    label: id,
    agent: id,
    temperature: 0.5,
    needsConfirmation: true,
    inputs: from.map((f) => ({ from: f, strategy: 'full' as const })),
    ...over,
  });
  const ok = [node('a', ['@input']), node('b', ['a']), node('c', ['a', 'b'])];

  it('合法图（含跨级边）通过', () => expect(validateStageGraph(ok)).toEqual([]));

  it.each([
    ['环', [node('a', ['@input', 'b']), node('b', ['a'])], /不在它之前|存在环/],
    ['自环', [node('a', ['@input']), node('b', ['b'])], /自环|不在它之前/],
    ['上游不存在', [node('a', ['@input']), node('b', ['ghost'])], /上游 ghost 不存在/],
    ['孤立节点（没有入边）', [node('a', ['@input']), node('b', [])], /没有任何入边/],
    ['多个 @input', [node('a', ['@input']), node('b', ['@input'])], /只能出现在首个阶段/],
    ['@input 不在首节点', [node('a', ['@input']), node('b', ['a', '@input'])], /只能出现在首个阶段/],
    ['首节点没有外部入口', [node('a', []), node('b', ['a'])], /必须消费 @input|没有任何入边/],
    ['id 重复', [node('a', ['@input']), node('a', ['a'])], /id 重复/],
    ['前向引用', [node('a', ['@input', 'b']), node('b', ['a'])], /不在它之前/],
    ['重复消费同一上游', [node('a', ['@input']), node('b', ['a', 'a'])], /重复消费/],
    ['温度越界', [node('a', ['@input'], { temperature: 3 })], /temperature/],
    ['空图', [], /为空/],
  ])('%s', (_name, graph, expected) => {
    expect(validateStageGraph(graph as StageNode[]).join('\n')).toMatch(expected as RegExp);
  });
});

describe('图与实际调用不漂移', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('图里声明的温度 = LlmService 实际发给模型的温度', async () => {
    process.env.LLM_PROVIDER = 'deepseek';
    process.env.DEEPSEEK_API_KEY = 'k';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sent: number[] = [];
    global.fetch = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body).temperature);
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
      return new Response(new TextEncoder().encode(sse), { status: 200 });
    }) as unknown as typeof fetch;

    const svc = new LlmService();
    const noop = () => undefined;
    const proto = { html: '', pages: [], flows: [] };
    await svc.generatePrd('x', noop);
    await svc.generatePrototype({}, noop);
    await svc.generateDesign({}, proto, noop);
    await svc.generateCodegen({}, proto, noop);
    await svc.generateDeploy({}, noop);

    // generatePrototype 解析失败时会带反馈再调一次（同温度），按阶段取各自第一次调用即可
    const firstPerStage = [sent[0], sent[1], sent.at(-3)!, sent.at(-2)!, sent.at(-1)!];
    expect(sent.length).toBeGreaterThanOrEqual(5);
    expect(firstPerStage).toEqual(STAGE_IDS.map((s) => stageNode(s).temperature));
  });
});
