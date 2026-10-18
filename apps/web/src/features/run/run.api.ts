/**
 * 页面对后端的请求。每个函数只做一件事，返回统一的结果形状，错误文案与原来页面里直接 fetch 时一致
 * （非 2xx 取响应正文，异常取 message）。fetch 可注入，测试时换成假的。
 */
import type { ApprovalView, PipelineDoc, PipelineDocSummary } from '@apploom/shared';
import type { StageId } from '@apploom/shared/graph';

export type Fetcher = typeof fetch;
export type Result<T = void> = { ok: true; data: T } | { ok: false; error: string; status?: number };

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function request<T>(fetcher: Fetcher, url: string, init: RequestInit | undefined, parse: (res: Response) => Promise<T>): Promise<Result<T>> {
  try {
    const res = await fetcher(url, init);
    if (!res.ok) return { ok: false, error: await res.text(), status: res.status };
    return { ok: true, data: await parse(res) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
const none = async (): Promise<void> => undefined;

export const runApi = (fetcher: Fetcher = (...a) => fetch(...a)) => ({
  /** 创建流水线，返回新 id */
  create: (requirement: string, confirmEachStep: boolean) =>
    request<string>(fetcher, '/api/pipeline', json({ requirement, confirmEachStep }), async (r) => ((await r.json()) as { id: string }).id),

  getDoc: (id: string) => request<PipelineDoc>(fetcher, `/api/pipeline/${id}`, undefined, async (r) => (await r.json()) as PipelineDoc),

  listHistory: () => request<PipelineDocSummary[]>(fetcher, '/api/pipeline', undefined, async (r) => ((await r.json()) as { items: PipelineDocSummary[] }).items),

  confirm: (id: string, stage: StageId) => request(fetcher, `/api/pipeline/${id}/confirm`, json({ stage }), none),

  /** 不传 stage 时由后端找失败的阶段 */
  retry: (id: string, stage?: StageId) => request(fetcher, `/api/pipeline/${id}/retry`, json({ stage }), none),

  /** feedback 省略 = 自动修复（后端用上次 error）；传空串 = 无反馈重新生成 */
  repair: (id: string, stage: StageId, feedback?: string) => request(fetcher, `/api/pipeline/${id}/repair`, json({ stage, feedback: feedback?.trim() }), none),

  listApprovals: (id: string) => request<ApprovalView[]>(fetcher, `/api/pipeline/${id}/approvals`, undefined, async (r) => ((await r.json()) as { items: ApprovalView[] }).items),

  /** 404 表示已超时或已被处理，对调用方等同成功（只需把它从列表里移除） */
  decideApproval: async (docId: string, approvalId: string, decision: 'approve' | 'reject'): Promise<Result> => {
    const r = await request(fetcher, `/api/pipeline/${docId}/approvals/${approvalId}`, json({ decision }), none);
    return !r.ok && r.status === 404 ? { ok: true, data: undefined } : r;
  },
});

export type RunApi = ReturnType<typeof runApi>;
