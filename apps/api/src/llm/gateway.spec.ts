import { chat, classifyError, classifyHttpStatus, LlmError, type LlmLogEntry } from '@apploom/llm';

const config = { baseURL: 'http://llm.test/v1', apiKey: 'k', model: 'm', supportsJsonSchema: false, streamUsage: true };

const okJson = (content: string, usage?: object) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage }), { status: 200 });

const sse = (events: object[]) =>
  new Response(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'), { status: 200 });

describe('错误分类', () => {
  it('HTTP 状态码映射', () => {
    expect(classifyHttpStatus(429)).toBe('transient');
    expect(classifyHttpStatus(503)).toBe('transient');
    expect(classifyHttpStatus(401)).toBe('permission');
    expect(classifyHttpStatus(404)).toBe('not_found');
    expect(classifyHttpStatus(400)).toBe('invalid_input');
  });

  it('LlmError 取自带类别；网络错误/超时视为 transient；其它 unknown', () => {
    expect(classifyError(new LlmError('x', 'permission'))).toBe('permission');
    expect(classifyError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe('transient');
    expect(classifyError(Object.assign(new TypeError('fetch failed'), {}))).toBe('transient');
    expect(classifyError(new Error('boom'))).toBe('unknown');
  });
});

describe('chat 网关', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('429 后自动退避重试并成功，两次调用都进日志', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 })).mockResolvedValueOnce(okJson('hi', { prompt_tokens: 5, completion_tokens: 2 }));
    const logs: LlmLogEntry[] = [];
    const p = chat(config, { user: 'u', onLog: (l) => logs.push(l) });
    await jest.advanceTimersByTimeAsync(5000);
    const r = await p;

    expect(r.content).toBe('hi');
    expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ attempt: 0, errorClass: 'transient' });
    expect(logs[1]).toMatchObject({ attempt: 1, finishReason: 'stop', model: 'm' });
  });

  it('401 不重试，抛 permission 类 LlmError', async () => {
    fetchMock.mockResolvedValue(new Response('bad key', { status: 401 }));
    const err = await chat(config, { user: 'u' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.errorClass).toBe('permission');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('transient 重试耗尽后抛出', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }));
    const p = chat(config, { user: 'u', maxRetries: 2 }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(20_000);
    const err = await p;
    expect(err.errorClass).toBe('transient');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('流式：解析真实 usage 与 finish_reason，并请求 include_usage', async () => {
    fetchMock.mockResolvedValue(
      sse([
        { choices: [{ delta: { content: 'ab' } }] },
        { choices: [{ delta: { content: 'c' }, finish_reason: 'length' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
      ]),
    );
    const tokens: string[] = [];
    const r = await chat(config, { user: 'u', stream: true, onToken: (t) => tokens.push(t) });

    expect(tokens.join('')).toBe('abc');
    expect(r).toMatchObject({ content: 'abc', finishReason: 'length', usage: { promptTokens: 10, completionTokens: 3 } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream_options).toEqual({ include_usage: true });
  });

  it('流式无 usage 时按字符估算并标记 estimated', async () => {
    fetchMock.mockResolvedValue(sse([{ choices: [{ delta: { content: 'abcdef' } }] }]));
    const logs: LlmLogEntry[] = [];
    await chat({ ...config, streamUsage: false }, { user: 'xyz', stream: true, onToken: () => undefined, onLog: (l) => logs.push(l) });
    expect(logs[0].usage).toMatchObject({ estimated: true, completionTokens: 2 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream_options).toBeUndefined();
  });

  it('流式已输出 token 后中断：不重试（避免重复推送）', async () => {
    // 先送出一个数据块，下一次 pull 再报错（controller.error 会丢弃队列中未读的块，不能同步 enqueue 后立即 error）
    let pulls = 0;
    const body = new ReadableStream({
      pull(c) {
        if (pulls++ === 0) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'part' } }] })}\n\n`));
        else c.error(new TypeError('fetch failed'));
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    const tokens: string[] = [];
    const err = await chat(config, { user: 'u', stream: true, onToken: (t) => tokens.push(t), maxRetries: 2 }).catch((e) => e);
    expect(tokens).toEqual(['part']);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.errorClass).toBe('transient');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('请求超时：抛 transient 且提示超时', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))));
    const err = await chat(config, { user: 'u', timeoutMs: 30, maxRetries: 0 }).catch((e) => e);
    expect(err.errorClass).toBe('transient');
    expect(err.message).toContain('超时');
  });
});
