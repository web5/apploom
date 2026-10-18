import { describe, expect, it, vi } from 'vitest';
import { runApi } from './run.api';

const res = (status: number, body: unknown = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
type FakeFetch = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
const fake = (r: Response | Error): FakeFetch =>
  vi.fn(async () => {
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as FakeFetch;
const call = (f: FakeFetch) => ({ url: f.mock.calls[0][0], init: f.mock.calls[0][1] as RequestInit });

describe('runApi', () => {
  it('create：POST /api/pipeline，返回新 id', async () => {
    const f = fake(res(201, { id: 'abc' }));
    expect(await runApi(f as never).create('做计数器', true)).toEqual({ ok: true, data: 'abc' });
    const { url, init } = call(f);
    expect(url).toBe('/api/pipeline');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ requirement: '做计数器', confirmEachStep: true });
  });

  it('非 2xx 取响应正文作错误文案（与原来页面直接 fetch 时一致），并带上状态码', async () => {
    expect(await runApi(fake(res(400, 'requirement 不能为空')) as never).create('', true)).toEqual({ ok: false, error: 'requirement 不能为空', status: 400 });
  });

  it('网络异常取 message', async () => {
    expect(await runApi(fake(new Error('fetch failed')) as never).getDoc('x')).toEqual({ ok: false, error: 'fetch failed' });
  });

  it('confirm / retry / repair 的路径与请求体；repair 的反馈会去掉首尾空白，省略时不带 feedback 字段内容', async () => {
    const f1 = fake(res(201, { ok: true })); await runApi(f1 as never).confirm('d1', 'prototype');
    expect(call(f1).url).toBe('/api/pipeline/d1/confirm'); expect(JSON.parse(call(f1).init.body as string)).toEqual({ stage: 'prototype' });
    const f2 = fake(res(201, { ok: true })); await runApi(f2 as never).retry('d1');
    expect(call(f2).url).toBe('/api/pipeline/d1/retry'); expect(JSON.parse(call(f2).init.body as string)).toEqual({});
    const f3 = fake(res(201, { ok: true })); await runApi(f3 as never).repair('d1', 'design', '  换深色  ');
    expect(JSON.parse(call(f3).init.body as string)).toEqual({ stage: 'design', feedback: '换深色' });
    const f4 = fake(res(201, { ok: true })); await runApi(f4 as never).repair('d1', 'design');
    expect(JSON.parse(call(f4).init.body as string)).toEqual({ stage: 'design' });
  });

  it('listHistory / listApprovals 取 items', async () => {
    expect(await runApi(fake(res(200, { items: [{ id: 'a' }] })) as never).listHistory()).toEqual({ ok: true, data: [{ id: 'a' }] });
    expect(await runApi(fake(res(200, { items: [] })) as never).listApprovals('d1')).toEqual({ ok: true, data: [] });
  });

  it('审批决策：404（已超时或已被处理）按成功处理；其它错误照常返回', async () => {
    expect((await runApi(fake(res(404, 'gone')) as never).decideApproval('d1', 'a1', 'approve')).ok).toBe(true);
    expect(await runApi(fake(res(500, 'boom')) as never).decideApproval('d1', 'a1', 'reject')).toMatchObject({ ok: false, error: 'boom', status: 500 });
    const f = fake(res(201, { ok: true })); await runApi(f as never).decideApproval('d1', 'a1', 'reject');
    expect(call(f).url).toBe('/api/pipeline/d1/approvals/a1'); expect(JSON.parse(call(f).init.body as string)).toEqual({ decision: 'reject' });
  });
});
