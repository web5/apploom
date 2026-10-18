'use client';

/**
 * 流水线运行的状态机 hook：reducer（服务端派生状态）+ SSE 订阅 + 对后端的命令 + 刷新后恢复上次会话。
 * 页面只管渲染与纯界面状态（输入框、展开的面板），所有「和服务端打交道」的事都在这里。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ApprovalView, PipelineDocSummary } from '@apploom/shared';
import { STAGE_IDS, type StageId } from '@apploom/shared/graph';
import { initialRunState, runReducer } from './run.reducer';
import { runApi } from './run.api';
import { connectRunEvents, type EventSourceLike } from './sse.adapter';

const LAST_PIPELINE_KEY = 'apploom:lastPipeline';
const allFalse = () => Object.fromEntries(STAGE_IDS.map((s) => [s, false])) as Record<StageId, boolean>;

export function useRunMachine() {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  /** 正在提交命令（确认 / 重试 / 修复）的阶段，用来禁用对应按钮 */
  const [busy, setBusy] = useState<Record<StageId, boolean>>(allFalse);
  const esRef = useRef<EventSourceLike | null>(null);
  const docIdRef = useRef<string | null>(null);
  const api = useMemo(() => runApi(), []);

  /** 拉取当前待审批项（页面刷新 / SSE 重连后 approval 事件不会重放，以接口为准） */
  const refreshApprovals = useCallback(
    async (id: string) => {
      const r = await api.listApprovals(id);
      if (!r.ok || docIdRef.current !== id) return; // 静默：下次 snapshot / approval 事件会再同步
      dispatch({ type: 'APPROVALS_SET', items: r.data });
    },
    [api],
  );

  /** 订阅 SSE 进度流 */
  const subscribe = useCallback(
    (id: string) => {
      esRef.current?.close();
      const es = new EventSource(`/api/pipeline/${id}/events`) as unknown as EventSourceLike;
      esRef.current = es;
      docIdRef.current = id;
      sessionStorage.setItem(LAST_PIPELINE_KEY, id);
      dispatch({ type: 'SUBSCRIBE_START' });
      void refreshApprovals(id);
      connectRunEvents(es, { dispatch, onSnapshot: () => void refreshApprovals(id) });
    },
    [refreshApprovals],
  );

  /** 创建异步任务并订阅进度 */
  async function start(requirement: string, confirmEachStep: boolean) {
    if (!requirement.trim()) return;
    dispatch({ type: 'RESET' });
    const r = await api.create(requirement, confirmEachStep);
    if (!r.ok) return dispatch({ type: 'ERROR_SET', message: r.error });
    subscribe(r.data);
  }

  /** 对某阶段提交一个命令：期间禁用该阶段按钮；失败时在页面顶部提示 */
  async function withBusy(stage: StageId, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
    setBusy((prev) => ({ ...prev, [stage]: true }));
    try {
      const r = await fn();
      if (!r.ok) dispatch({ type: 'ERROR_SET', message: r.error ?? '' });
      return r.ok;
    } finally {
      setBusy((prev) => ({ ...prev, [stage]: false }));
    }
  }

  /** 逐步确认：放行下一阶段 */
  async function confirmStage(stage: StageId) {
    const id = docIdRef.current;
    if (!id) return;
    await withBusy(stage, () => api.confirm(id, stage));
  }

  /** 失败重试：不传 stage 则重试失败的阶段 */
  async function retryStage(stage?: StageId) {
    const id = docIdRef.current;
    if (!id) return;
    const target = stage ?? STAGE_IDS.find((s) => state.doc?.stages[s].status === 'failed');
    if (!target) return;
    await withBusy(target, () => api.retry(id, target));
  }

  /** AI 修复/修改：带反馈重新生成。feedback 省略则自动用 error（自动修复）。成功返回 true，调用方据此收起输入框 */
  async function repairStage(stage: StageId, feedback?: string): Promise<boolean> {
    const id = docIdRef.current;
    if (!id) return false;
    const ok = await withBusy(stage, () => api.repair(id, stage, feedback));
    // completed 任务修改后 SSE 已关闭（done 事件里会主动 close），重新订阅以接收后续进度
    if (ok) subscribe(id);
    return ok;
  }

  /** 断开订阅（任务仍在后台执行，仅停止实时跟踪） */
  function disconnect() {
    esRef.current?.close();
    esRef.current = null;
    docIdRef.current = null;
    sessionStorage.removeItem(LAST_PIPELINE_KEY);
    dispatch({ type: 'DISCONNECTED' });
  }

  /** 加载历史项目列表；失败时提示并返回 null */
  async function loadHistory(): Promise<PipelineDocSummary[] | null> {
    const r = await api.listHistory();
    if (!r.ok) {
      dispatch({ type: 'ERROR_SET', message: r.error });
      return null;
    }
    return r.data;
  }

  /** 打开历史项目：加载完整文档；未结束则重新订阅，已结束仅展示。成功返回 true */
  async function openDoc(id: string): Promise<boolean> {
    esRef.current?.close();
    const r = await api.getDoc(id);
    if (!r.ok) {
      dispatch({ type: 'ERROR_SET', message: r.error });
      return false;
    }
    dispatch({ type: 'DOC_LOADED', doc: r.data });
    docIdRef.current = id;
    sessionStorage.setItem(LAST_PIPELINE_KEY, id);
    if (r.data.status === 'completed' || r.data.status === 'failed') dispatch({ type: 'CONNECTION', connected: false });
    else subscribe(id);
    return true;
  }

  /** 人工决策：404（已超时或已被处理）按成功处理；无论结果都把它从列表移除 */
  async function decideApproval(a: ApprovalView, decision: 'approve' | 'reject') {
    const r = await api.decideApproval(a.docId, a.id, decision);
    if (!r.ok) dispatch({ type: 'ERROR_SET', message: r.error });
    dispatch({ type: 'APPROVAL_REMOVED', id: a.id });
  }

  // 挂载时恢复上次未完成的任务（页面刷新后能续上）
  useEffect(() => {
    const id = sessionStorage.getItem(LAST_PIPELINE_KEY);
    if (!id) return;
    void (async () => {
      const r = await api.getDoc(id);
      // 没有 HTTP 状态码 = 网络层失败（后端没起来），保留记录等下次；有状态码的失败（如 404）才清掉
      if (!r.ok) {
        if (r.status !== undefined) sessionStorage.removeItem(LAST_PIPELINE_KEY);
        return;
      }
      dispatch({ type: 'DOC_LOADED', doc: r.data });
      if (r.data.status === 'completed') sessionStorage.removeItem(LAST_PIPELINE_KEY);
      else subscribe(id);
    })();
    return () => esRef.current?.close();
  }, [api, subscribe]);

  return { state, busy, start, confirmStage, retryStage, repairStage, disconnect, loadHistory, openDoc, decideApproval };
}
