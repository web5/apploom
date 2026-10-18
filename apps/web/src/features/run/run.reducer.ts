/**
 * 流水线运行状态机的 reducer：把「服务端推过来的事实」集中到一个纯函数里。
 *
 * 之前这些变化散在 Studio 页面里十几个 setXxx 调用中，只能靠手点页面验证；现在可以用一串事件序列直接单测
 * （事件乱序、重连补帧、确认竞态、断开等）。只管服务端派生状态；输入框、展开面板这类纯界面状态留在组件里。
 */
import { STAGE_IDS, STAGE_LABEL, type StageId } from '@apploom/shared/graph';
import type { ApprovalView, ErrorClass, PipelineDoc, PipelineStatus, StageStatus } from '@apploom/shared';

export interface RunState {
  /** 当前正在看的流水线（null = 还没开始 / 已断开） */
  doc: PipelineDoc | null;
  /** 各阶段流式输出的累积文本（仅用于展示进度，刷新页面后不保留） */
  tokens: Record<StageId, string>;
  /** 等待人工审批的高风险操作 */
  approvals: ApprovalView[];
  /** 是否有活跃的实时连接 */
  connected: boolean;
  /** 页面顶部的错误提示 */
  error: string;
}

export type RunAction =
  /** 开始订阅一条流水线：清掉旧的错误与审批，标记已连接 */
  | { type: 'SUBSCRIBE_START' }
  /** 连接状态变化（EventSource 出错时置 false；自动重连成功后由 SNAPSHOT 带回 true 由 SUBSCRIBE_START 保证） */
  | { type: 'CONNECTION'; connected: boolean }
  | { type: 'SNAPSHOT'; doc: PipelineDoc }
  | { type: 'STAGE'; stage: StageId; status: StageStatus; summary?: unknown; result?: unknown; error?: string; errorClass?: ErrorClass }
  | { type: 'TOKEN'; stage: StageId; token: string }
  | { type: 'JOB'; status: PipelineStatus }
  | { type: 'DONE'; doc: PipelineDoc }
  | { type: 'PIPELINE_ERROR'; stage: StageId; message: string }
  | { type: 'APPROVAL_ADDED'; approval: ApprovalView }
  | { type: 'APPROVAL_REMOVED'; id: string }
  /** 用接口返回的完整列表覆盖（刷新页面 / 重连后 approval 事件不会重放，以接口为准） */
  | { type: 'APPROVALS_SET'; items: ApprovalView[] }
  /** 载入一条已有的流水线（历史项目 / 刷新后恢复）：换掉文档并清空流式输出 */
  | { type: 'DOC_LOADED'; doc: PipelineDoc }
  /** 开始一条新的：清空文档、流式输出与错误 */
  | { type: 'RESET' }
  /** 手动断开实时连接：任务仍在后台执行，只是不再跟踪 */
  | { type: 'DISCONNECTED' }
  | { type: 'ERROR_SET'; message: string };

export function emptyTokens(): Record<StageId, string> {
  return Object.fromEntries(STAGE_IDS.map((s) => [s, ''])) as Record<StageId, string>;
}

export const initialRunState: RunState = {
  doc: null,
  tokens: emptyTokens(),
  approvals: [],
  connected: false,
  error: '',
};

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'SUBSCRIBE_START':
      return { ...state, error: '', approvals: [], connected: true };

    case 'CONNECTION':
      return state.connected === action.connected ? state : { ...state, connected: action.connected };

    case 'SNAPSHOT':
      return { ...state, doc: action.doc };

    case 'STAGE': {
      if (!state.doc) return state;
      const prev = state.doc.stages[action.stage];
      const failed = action.status === 'failed';
      return {
        ...state,
        doc: {
          ...state.doc,
          stages: {
            ...state.doc.stages,
            [action.stage]: {
              ...prev,
              status: action.status,
              summary: action.summary ?? prev.summary,
              result: action.result ?? prev.result,
              // 失败时带上真实原因与类别；其它状态清掉旧的失败信息
              error: failed ? action.error ?? prev.error : undefined,
              errorClass: failed ? action.errorClass ?? prev.errorClass : undefined,
            },
          },
        },
      };
    }

    case 'TOKEN':
      return { ...state, tokens: { ...state.tokens, [action.stage]: state.tokens[action.stage] + action.token } };

    case 'JOB':
      return state.doc ? { ...state, doc: { ...state.doc, status: action.status } } : state;

    case 'DONE':
      return { ...state, doc: action.doc, approvals: [], connected: false };

    case 'PIPELINE_ERROR':
      return { ...state, error: `阶段「${STAGE_LABEL[action.stage]}」失败：${action.message}` };

    case 'APPROVAL_ADDED':
      return state.approvals.some((a) => a.id === action.approval.id) ? state : { ...state, approvals: [...state.approvals, action.approval] };

    case 'APPROVAL_REMOVED':
      return { ...state, approvals: state.approvals.filter((a) => a.id !== action.id) };

    case 'APPROVALS_SET':
      return { ...state, approvals: action.items };

    case 'DOC_LOADED':
      return { ...state, doc: action.doc, tokens: emptyTokens() };

    case 'RESET':
      return { ...state, doc: null, tokens: emptyTokens(), error: '' };

    case 'DISCONNECTED':
      return { ...state, doc: null, tokens: emptyTokens(), connected: false, error: '已断开实时连接，任务仍在后台执行。' };

    case 'ERROR_SET':
      return { ...state, error: action.message };
  }
}
