/**
 * 混沌测试：故意制造故障，验证 harness 不崩溃、错误被正确分类、该重试的重试、该终止的终止、trace 完整。
 * 走真实的 LlmService + 网关 + PipelineService，只把 fetch 换成脚本化的故障源，因此不花 token。
 */
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ on: jest.fn(), quit: jest.fn() })),
}));

import { LlmService } from '../prd/llm.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { createPipelineDoc, type AttemptRecord, type PipelineDoc, type PipelineEvent } from '../pipeline/pipeline.types';

const VALID_PRD = {
  overview: '计数器',
  targetUsers: ['个人'],
  features: [{ id: 'F1', name: '计数', priority: 'P0', desc: '加减' }],
  userStories: ['As a user'],
  pages: ['home'],
  entities: [],
  assumptions: ['纯前端'],
};

const enc = new TextEncoder();
const sseChunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;

/** 正常的流式响应：content 分两段送出，附 usage */
function okStream(content: string, usage = { prompt_tokens: 100, completion_tokens: 50 }, finish = 'stop'): Response {
  const mid = Math.max(1, Math.floor(content.length / 2));
  const body = [
    sseChunk({ choices: [{ delta: { content: content.slice(0, mid) } }] }),
    sseChunk({ choices: [{ delta: { content: content.slice(mid) }, finish_reason: finish }] }),
    sseChunk({ choices: [], usage }),
    'data: [DONE]\n\n',
  ].join('');
  return new Response(enc.encode(body), { status: 200 });
}

/** 流到一半断开：先送一段内容，下一次 pull 报网络错误 */
function brokenStream(): Response {
  let n = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (n++ === 0) c.enqueue(enc.encode(sseChunk({ choices: [{ delta: { content: '{"overview":"半截' } }] })));
        else c.error(new TypeError('fetch failed'));
      },
    }),
    { status: 200 },
  );
}

const httpError = (status: number) => new Response(`error ${status}`, { status });

class FakeStore {
  constructor(public doc: PipelineDoc) {}
  async get() { return structuredClone(this.doc); }
  async update(_id: string, fn: (d: PipelineDoc) => void) { fn(this.doc); return this.doc; }
}

function setup(script: Array<() => Response | Promise<Response>>, opts: { traceListFails?: boolean } = {}) {
  const doc = createPipelineDoc('做一个计数器', false);
  doc.id = 'chaos';
  doc.currentStage = 'requirement';
  const events: PipelineEvent[] = [];
  const records: AttemptRecord[] = [];
  const bus = { emit: jest.fn((_id: string, e: PipelineEvent) => void events.push(e)) };
  const trace = {
    append: jest.fn(async (r: AttemptRecord) => void records.push(r)),
    list: jest.fn(async () => { if (opts.traceListFails) throw new Error('redis down'); return records; }),
  };
  const svc = new PipelineService(new FakeStore(doc) as never, bus as never, new LlmService(), {} as never, {} as never, trace as never);
  (svc as unknown as { queue: unknown }).queue = { add: jest.fn() };

  let i = 0;
  const fetchMock = jest.fn(async () => {
    const step = script[Math.min(i++, script.length - 1)];
    return step();
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  const run = () => (svc as unknown as { processStage(j: unknown): Promise<void> }).processStage({ data: { docId: 'chaos', stage: 'requirement' } });
  const tokens = () => events.filter((e) => e.type === 'token').map((e) => (e as { token: string }).token).join('');
  return { doc, records, events, fetchMock, run, tokens };
}

describe('混沌测试', () => {
  const realFetch = global.fetch;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.LLM_PROVIDER = 'deepseek';
    process.env.DEEPSEEK_API_KEY = 'test-key';
    process.env.LLM_MAX_RETRIES = '2';
    process.env.STAGE_AUTO_REPAIRS = '1';
    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.PIPELINE_TOKEN_BUDGET;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...savedEnv };
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** 跑一个阶段；期间推进假时钟，让网关的退避等待立即过去 */
  async function runWithClock(run: () => Promise<void>): Promise<unknown> {
    const p = run().then(() => undefined, (e) => e);
    for (let k = 0; k < 40; k++) await jest.advanceTimersByTimeAsync(1000);
    return p;
  }

  it('429 限流两次后恢复：网关自动退避重试，阶段成功，用户无感知', async () => {
    const { doc, records, fetchMock, run } = setup([() => httpError(429), () => httpError(429), () => okStream(JSON.stringify(VALID_PRD))]);
    expect(await runWithClock(run)).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(doc.stages.requirement.status).toBe('done');
    expect(records).toHaveLength(1);
    expect(records[0].llmLogs.map((l) => l.errorClass)).toEqual(['transient', 'transient', undefined]);
  });

  it('503 持续不恢复：重试耗尽后以 transient 失败，不死循环', async () => {
    const { doc, records, fetchMock, run } = setup([() => httpError(503)]);
    const err = await runWithClock(run);

    expect(err).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
    expect(doc.stages.requirement).toMatchObject({ status: 'failed', errorClass: 'transient' });
    expect(records).toHaveLength(1); // transient 不触发自动修复
  });

  it('主模型 503 + 配置了备用模型：自动切到备用并成功，日志记录切换原因', async () => {
    process.env.LLM_FALLBACK_PROVIDER = 'hunyuan';
    process.env.HUNYUAN_API_KEY = 'hy-key';
    process.env.LLM_MAX_RETRIES = '0';
    const calls: string[] = [];
    const { doc, records, run } = setup([
      () => httpError(503),
      () => okStream(JSON.stringify(VALID_PRD)),
    ]);
    const inner = global.fetch as jest.Mock;
    global.fetch = jest.fn(async (url: string, init: RequestInit) => { calls.push(String(url)); return inner(url, init); }) as never;

    expect(await runWithClock(run)).toBeUndefined();
    expect(calls[0]).toContain('api.deepseek.com');
    expect(calls[1]).toContain('tencentmaas.com');
    expect(doc.stages.requirement.status).toBe('done');
    expect(records[0].llmLogs.at(-1)?.fallbackReason).toContain('已切换备用模型');
  });

  it('流式输出到一半网络中断：不重试不重复推送，以 transient 失败', async () => {
    const { doc, fetchMock, run, tokens } = setup([() => brokenStream()]);
    const err = await runWithClock(run);

    expect(err).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokens().match(/半截/g)).toHaveLength(1); // 前端只收到一次，没有重复
    expect(doc.stages.requirement).toMatchObject({ status: 'failed', errorClass: 'transient' });
    expect(doc.stages.requirement.llmLogs).toHaveLength(1); // 失败的调用也有记录
  });

  it('401 鉴权失败：不重试、不自动修复，类别为 permission', async () => {
    const { doc, records, fetchMock, run } = setup([() => httpError(401)]);
    await runWithClock(run);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(doc.stages.requirement.errorClass).toBe('permission');
  });

  it('模型返回畸形 JSON：自动回喂校验错误重试一次，修复后成功', async () => {
    const { doc, records, fetchMock, run } = setup([() => okStream('这不是 JSON，抱歉'), () => okStream(JSON.stringify(VALID_PRD))]);
    expect(await runWithClock(run)).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondPrompt = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)).messages.at(-1).content as string;
    expect(secondPrompt).toContain('上一次输出未通过契约校验');
    expect(records.map((r) => r.trigger)).toEqual(['initial', 'auto-repair']);
    expect(doc.stages.requirement.status).toBe('done');
  });

  it('模型一直返回畸形 JSON：自动修复用尽后失败为 invalid_output，不无限循环', async () => {
    const { doc, records, fetchMock, run } = setup([() => okStream('garbage')]);
    await runWithClock(run);

    expect(fetchMock).toHaveBeenCalledTimes(2); // 首次 + 1 次自动修复
    expect(records).toHaveLength(2);
    expect(doc.stages.requirement).toMatchObject({ status: 'failed', errorClass: 'invalid_output' });
  });

  /** 取第 n 次 fetch 的请求体 */
  const bodyOf = (fetchMock: jest.Mock, n: number) => JSON.parse((fetchMock.mock.calls as unknown as [string, { body: string }][])[n][1].body);

  it('输出被 max_tokens 截断：归为 truncated，自动放大输出上限并要求精简，不回喂半截输出', async () => {
    const cut = JSON.stringify(VALID_PRD).slice(0, 60);
    const { doc, fetchMock, records, run } = setup([() => okStream(cut, undefined, 'length'), () => okStream(JSON.stringify(VALID_PRD))]);
    expect(await runWithClock(run)).toBeUndefined();

    expect(records.map((r) => [r.trigger, r.outcome, r.errorClass])).toEqual([
      ['initial', 'failed', 'truncated'],
      ['auto-repair', 'done', undefined],
    ]);
    expect(records[0].error).toMatch(/截断/);
    expect(records[0].llmLogs[0].finishReason).toBe('length');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(doc.stages.requirement.status).toBe('done');

    // PRD 阶段首次未设 maxTokens；放大后以 4096 为基数翻倍
    expect(bodyOf(fetchMock, 0).max_tokens).toBeUndefined();
    expect(bodyOf(fetchMock, 1).max_tokens).toBe(8192);
    const prompt = bodyOf(fetchMock, 1).messages.at(-1).content as string;
    expect(prompt).toContain('精简');
    expect(prompt).not.toContain(cut);
  });

  it('持续被截断：放大一次后仍失败，以 truncated 终止，不死循环', async () => {
    const cut = JSON.stringify(VALID_PRD).slice(0, 60);
    const { doc, fetchMock, records, run } = setup([() => okStream(cut, undefined, 'length')]);
    expect(await runWithClock(run)).toBeInstanceOf(Error);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(records.map((r) => r.errorClass)).toEqual(['truncated', 'truncated']);
    expect(doc.stages.requirement).toMatchObject({ status: 'failed', errorClass: 'truncated' });
  });

  it('推理耗尽额度导致正文为空（finish_reason=length）：同样按 truncated 自愈', async () => {
    const { fetchMock, records, run } = setup([() => okStream('', undefined, 'length'), () => okStream(JSON.stringify(VALID_PRD))]);
    expect(await runWithClock(run)).toBeUndefined();
    expect(records[0]).toMatchObject({ errorClass: 'truncated' });
    expect(records[0].error).toMatch(/正文为空/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('finish_reason=length 但内容恰好是完整合法 JSON：照常接受，不触发自愈', async () => {
    const { doc, fetchMock, run } = setup([() => okStream(JSON.stringify(VALID_PRD), undefined, 'length')]);
    expect(await runWithClock(run)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(doc.stages.requirement.status).toBe('done');
  });

  it('放大封顶 LLM_MAX_TOKENS_CEILING（如 DeepSeek 官方 API 上限 8192）', async () => {
    process.env.LLM_MAX_TOKENS_CEILING = '4096';
    const cut = JSON.stringify(VALID_PRD).slice(0, 60);
    const { fetchMock, run } = setup([() => okStream(cut, undefined, 'length'), () => okStream(JSON.stringify(VALID_PRD))]);
    expect(await runWithClock(run)).toBeUndefined();
    expect(bodyOf(fetchMock, 1).max_tokens).toBe(4096);
  });

  it('原型阶段被截断：不在 LlmService 内白白再调一次模型，交给流水线放大后重跑', async () => {
    const svc = new LlmService();
    const fetchMock = jest.fn(async () => okStream('{"html":"<div>半截', undefined, 'length'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await svc.generatePrototype({ prd: 1 }, () => undefined);
    expect(r).toMatchObject({ errorClass: 'truncated' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('代码生成放大：基数 8192 → 16384；再次放大封顶', async () => {
    const svc = new LlmService();
    const fetchMock = jest.fn(async () => okStream('{}'));
    global.fetch = fetchMock as unknown as typeof fetch;
    await svc.generateCodegen({}, {}, () => undefined, { feedback: 'x', maxTokensLevel: 1 });
    await svc.generateCodegen({}, {}, () => undefined, { feedback: 'x', maxTokensLevel: 3 });
    await svc.generateCodegen({}, {}, () => undefined);
    expect([0, 1, 2].map((n) => bodyOf(fetchMock as unknown as jest.Mock, n).max_tokens)).toEqual([16384, 16384, 8192]);
  });

  it('JSON 合法但字段违反 schema（缺字段 / 类型错误）：归为 invalid_output 并自动修复', async () => {
    const { doc, fetchMock, run } = setup([
      () => okStream(JSON.stringify({ ...VALID_PRD, features: 'oops', pages: undefined })),
      () => okStream(JSON.stringify(VALID_PRD)),
    ]);
    expect(await runWithClock(run)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(doc.stages.requirement.status).toBe('done');
  });

  it('上下文/用量突然暴增：本阶段完成后，下一次调用被预算熔断拦下', async () => {
    process.env.PIPELINE_TOKEN_BUDGET = '1000';
    const { doc, records, fetchMock, run } = setup([() => okStream('garbage', { prompt_tokens: 900, completion_tokens: 300 })]);
    await runWithClock(run);

    // 首次调用后累计 1200 ≥ 1000，自动修复前的守卫直接熔断
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(records.map((r) => r.errorClass)).toEqual(['invalid_output', 'budget']);
    expect(doc.stages.requirement.errorClass).toBe('budget');
  });

  it('trace 存储故障（Redis 不可用）：不影响流水线主流程', async () => {
    const { doc, run } = setup([() => okStream(JSON.stringify(VALID_PRD))], { traceListFails: true });
    expect(await runWithClock(run)).toBeUndefined();
    expect(doc.stages.requirement.status).toBe('done');
  });

  it('请求挂起超时：被超时中断并按 transient 处理，不会永远卡住', async () => {
    process.env.LLM_TIMEOUT_MS = '50';
    process.env.LLM_MAX_RETRIES = '0';
    jest.useRealTimers(); // 超时依赖真实的 AbortSignal.timeout
    const { doc, run } = setup([
      () => new Promise<Response>(() => undefined), // 永不返回
    ]);
    // 让 fetch 感知 abort：重写为监听 signal
    global.fetch = jest.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))) as never;

    const err = await run().then(() => undefined, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(doc.stages.requirement).toMatchObject({ status: 'failed', errorClass: 'transient' });
    expect(doc.stages.requirement.error).toContain('超时');
  });
});
