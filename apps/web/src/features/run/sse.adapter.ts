/**
 * SSE 适配层：把后端推来的「事件名 + 原始 JSON」翻译成 reducer 的 action。
 * 后端事件见 apps/api 的 pipeline.controller.ts。解析是纯函数，连接则接收一个已构造的 EventSource（便于测试时换成假的）。
 */
import type { ApprovalView, ErrorClass, PipelineDoc, PipelineStatus, StageStatus } from '@apploom/shared';
import type { StageId } from '@apploom/shared/graph';
import type { RunAction } from './run.reducer';

/** 需要订阅的事件名。`pipeline-error` 而不是 `error`，避开 EventSource 原生的 error 事件 */
export const RUN_EVENT_NAMES = ['snapshot', 'stage', 'approval', 'approval-resolved', 'token', 'job', 'done', 'pipeline-error'] as const;
export type RunEventName = (typeof RUN_EVENT_NAMES)[number];

/** 兼容连接时直接推 doc 与 { doc } 两种形态 */
function docOf(data: unknown): PipelineDoc {
  const d = data as { doc?: PipelineDoc } | PipelineDoc;
  return ((d as { doc?: PipelineDoc })?.doc ?? d) as PipelineDoc;
}

/** 解析一条 SSE 事件。数据损坏 / 事件名未知返回 null，由调用方忽略（一条坏消息不该拖垮整个页面） */
export function parseRunEvent(name: string, raw: string): RunAction | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  switch (name) {
    case 'snapshot':
      return { type: 'SNAPSHOT', doc: docOf(data) };
    case 'stage':
      return {
        type: 'STAGE',
        stage: data.stage as StageId,
        status: data.status as StageStatus,
        summary: data.summary,
        result: data.result,
        error: data.error as string | undefined,
        errorClass: data.errorClass as ErrorClass | undefined,
      };
    case 'approval':
      return { type: 'APPROVAL_ADDED', approval: data.approval as ApprovalView };
    case 'approval-resolved':
      return { type: 'APPROVAL_REMOVED', id: data.id as string };
    case 'token':
      return { type: 'TOKEN', stage: data.stage as StageId, token: data.token as string };
    case 'job':
      return { type: 'JOB', status: data.status as PipelineStatus };
    case 'done':
      return { type: 'DONE', doc: data.doc as PipelineDoc };
    case 'pipeline-error':
      return { type: 'PIPELINE_ERROR', stage: data.stage as StageId, message: data.message as string };
    default:
      return null;
  }
}

/** EventSource 里我们用到的那一小部分，测试里用假的实现 */
export interface EventSourceLike {
  addEventListener(name: string, listener: (e: { data: string }) => void): void;
  close(): void;
  onerror: ((e: unknown) => void) | null;
}

export interface RunConnectionHandlers {
  dispatch: (action: RunAction) => void;
  /** 收到完整快照后的回调：用来重新拉取审批列表（approval 事件不会随重连重放） */
  onSnapshot?: () => void;
}

/** 把一个已创建的 EventSource 接到 reducer 上 */
export function connectRunEvents(es: EventSourceLike, { dispatch, onSnapshot }: RunConnectionHandlers): void {
  for (const name of RUN_EVENT_NAMES) {
    es.addEventListener(name, (e) => {
      const action = parseRunEvent(name, e.data);
      if (!action) return;
      dispatch(action);
      if (action.type === 'SNAPSHOT') onSnapshot?.();
      // 任务结束：服务端不会再推了，主动关掉，避免 EventSource 自动重连
      if (action.type === 'DONE') es.close();
    });
  }
  // 原生连接错误：EventSource 会自动重连（服务端有心跳兜底），这里只更新「实时连接」指示
  es.onerror = () => dispatch({ type: 'CONNECTION', connected: false });
}
