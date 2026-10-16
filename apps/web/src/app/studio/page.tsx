'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalPanel, type ApprovalView } from '@/components/studio/ApprovalPanel';
import { errorClassMeta } from '@/components/studio/errorClass';

type Stage = 'requirement' | 'prototype' | 'design' | 'codegen' | 'deploy';
type Status = 'pending' | 'running' | 'done' | 'error' | 'waiting_confirm';

// ===== 后端 PipelineDoc 契约（对齐 apps/api/src/pipeline/pipeline.types.ts）=====
type PipelineStatus = 'created' | 'running' | 'waiting_confirm' | 'failed' | 'completed';
type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'waiting_confirm';
interface StageState {
  status: StageStatus;
  result?: unknown;
  raw?: string;
  summary?: unknown;
  error?: string;
  /** 失败类别（决定恢复策略），见 components/studio/errorClass.ts */
  errorClass?: string;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  llmLogs?: LlmLogEntry[];
}
interface LlmLogEntry {
  label: string;
  ts: string;
  user: string;
  response: string;
}
interface PipelineDoc {
  id: string;
  requirement: string;
  status: PipelineStatus;
  confirmEachStep: boolean;
  currentStage: Stage | null;
  stages: Record<Stage, StageState>;
  pendingConfirms: Stage[];
  handoffs: Record<Stage, boolean>;
  createdAt: string;
  updatedAt: string;
}

interface PipelineDocSummary {
  id: string;
  requirement: string;
  status: PipelineStatus;
  currentStage: Stage | null;
  createdAt: string;
  updatedAt: string;
  stages: Record<Stage, StageStatus>;
}

interface Feature { id: string; name: string; priority: 'P0' | 'P1' | 'P2'; desc: string; }
interface PRD {
  overview: string; targetUsers: string[]; features: Feature[];
  userStories: string[]; pages: string[];
  entities: { name: string; fields: string[] }[];
  assumptions: string[];
}
interface Design {
  techStack: string[]; architecture: string;
  pageTree: { path: string; component: string; description: string }[];
  dataModels: { name: string; fields: { name: string; type: string }[] }[];
  apis: { method: string; path: string; description: string }[];
}
interface Codegen {
  files: { path: string; content: string }[];
  dependencies: string[];
  runCommand: string;
  notes: string[];
}
interface Deploy {
  target: 'local' | 'cloud' | 'git';
  url: string;
  repoUrl: string;
  buildLog: string;
  status: 'success' | 'failed';
}
interface Prototype {
  appName: string; designStyle: string;
  html: string;
  pages: { id: string; title: string }[];
  flows: { name: string; description: string }[];
}

const STAGE_LABEL: Record<Stage, string> = {
  requirement: '需求拆解',
  prototype: '产品原型',
  design: '方案设计',
  codegen: '代码生成',
  deploy: '部署发布',
};

const STAGES: Stage[] = ['requirement', 'prototype', 'design', 'codegen', 'deploy'];

function emptyTokens(): Record<Stage, string> {
  return { requirement: '', prototype: '', design: '', codegen: '', deploy: '' };
}

/** 后端 StageStatus → 前端 Status */
function toStatus(s?: StageStatus): Status {
  switch (s) {
    case 'running': return 'running';
    case 'done': return 'done';
    case 'failed': return 'error';
    case 'waiting_confirm': return 'waiting_confirm';
    default: return 'pending';
  }
}

export default function StudioPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) {
    return <div style={{ padding: 40, color: '#9ca3af', fontSize: 13 }} suppressHydrationWarning>加载 Studio…</div>;
  }

  return <StudioPageInner />;
}

function StudioPageInner() {
  const [requirement, setRequirement] = useState('做一个团队待办事项应用，支持任务指派和看板');
  const [confirmMode, setConfirmMode] = useState(true);
  const [doc, setDoc] = useState<PipelineDoc | null>(null);
  const [tokens, setTokens] = useState<Record<Stage, string>>(emptyTokens());
  const [busy, setBusy] = useState<Record<Stage, boolean>>({ requirement: false, prototype: false, design: false, codegen: false, deploy: false });
  const [repairOpen, setRepairOpen] = useState<Stage | null>(null);
  const [repairText, setRepairText] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<PipelineDocSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [logOpen, setLogOpen] = useState<Stage | null>(null);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const docIdRef = useRef<string | null>(null);

  /** 拉取当前待审批项（页面刷新 / SSE 重连后 approval 事件不会重放，以接口为准） */
  const refreshApprovals = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/pipeline/${id}/approvals`);
      if (!res.ok || docIdRef.current !== id) return;
      const { items } = (await res.json()) as { items: ApprovalView[] };
      setApprovals(items);
    } catch { /* 静默：下次 snapshot / approval 事件会再同步 */ }
  }, []);

  /** 人工决策：404 表示已超时或已被处理，直接从列表移除 */
  const decideApproval = useCallback(async (a: ApprovalView, decision: 'approve' | 'reject') => {
    try {
      const res = await fetch(`/api/pipeline/${a.docId}/approvals/${a.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok && res.status !== 404) setError(await res.text());
    } catch (e) {
      setError((e as Error).message);
    }
    setApprovals((prev) => prev.filter((x) => x.id !== a.id));
  }, []);

  /** 订阅 SSE 进度流。后端事件见 pipeline.controller.ts */
  const subscribe = useCallback((id: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/pipeline/${id}/events`);
    esRef.current = es;
    docIdRef.current = id;
    sessionStorage.setItem('apploom:lastPipeline', id);
    setError('');
    setApprovals([]);
    setConnected(true);
    void refreshApprovals(id);

    // 兼容连接时直接推 doc 与 { doc } 两种形态
    const parseDoc = (e: MessageEvent): PipelineDoc => {
      const data = JSON.parse(e.data);
      return (data?.doc ?? data) as PipelineDoc;
    };

    es.addEventListener('snapshot', (e) => {
      setDoc(parseDoc(e as MessageEvent));
      void refreshApprovals(id);
    });
    es.addEventListener('stage', (e) => {
      const { stage, status, summary, result, error: stageError, errorClass } = JSON.parse((e as MessageEvent).data) as {
        stage: Stage; status: StageStatus; summary?: unknown; result?: unknown; error?: string; errorClass?: string;
      };
      setDoc((prev) => prev ? {
        ...prev,
        stages: {
          ...prev.stages,
          [stage]: {
            ...prev.stages[stage],
            status,
            summary: summary ?? prev.stages[stage].summary,
            result: result ?? prev.stages[stage].result,
            // 失败时带上真实原因与类别；其它状态清掉旧的失败信息
            error: status === 'failed' ? stageError ?? prev.stages[stage].error : undefined,
            errorClass: status === 'failed' ? errorClass ?? prev.stages[stage].errorClass : undefined,
          },
        },
      } : prev);
    });
    es.addEventListener('approval', (e) => {
      const { approval } = JSON.parse((e as MessageEvent).data) as { approval: ApprovalView };
      setApprovals((prev) => (prev.some((a) => a.id === approval.id) ? prev : [...prev, approval]));
    });
    es.addEventListener('approval-resolved', (e) => {
      const { id: resolvedId } = JSON.parse((e as MessageEvent).data) as { id: string };
      setApprovals((prev) => prev.filter((a) => a.id !== resolvedId));
    });
    es.addEventListener('token', (e) => {
      const { stage, token } = JSON.parse((e as MessageEvent).data) as { stage: Stage; token: string };
      setTokens((prev) => ({ ...prev, [stage]: prev[stage] + token }));
    });
    es.addEventListener('job', (e) => {
      const { status } = JSON.parse((e as MessageEvent).data);
      setDoc((prev) => prev ? { ...prev, status } : prev);
    });
    es.addEventListener('done', (e) => {
      const { doc } = JSON.parse((e as MessageEvent).data);
      setDoc(doc);
      setApprovals([]);
      setConnected(false);
      es.close();
    });
    es.addEventListener('pipeline-error', (e) => {
      const { stage, message } = JSON.parse((e as MessageEvent).data);
      setError(`阶段「${STAGE_LABEL[stage as Stage]}」失败：${message}`);
    });

    // 原生连接错误：EventSource 会自动重连（心跳兜底），仅提示
    es.onerror = () => setConnected(false);
  }, [refreshApprovals]);

  /** 创建异步任务并订阅进度 */
  async function start() {
    if (!requirement.trim()) return;
    setDoc(null);
    setTokens(emptyTokens());
    setError('');
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirement, confirmEachStep: confirmMode }),
      });
      if (!res.ok) { setError(await res.text()); return; }
      const { id } = await res.json();
      subscribe(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** 逐步确认：放行下一阶段 */
  async function confirmStage(stage: Stage) {
    const id = docIdRef.current;
    if (!id) return;
    setBusy((prev) => ({ ...prev, [stage]: true }));
    try {
      const res = await fetch(`/api/pipeline/${id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) setError(await res.text());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((prev) => ({ ...prev, [stage]: false }));
    }
  }

  /** 失败重试：不传 stage 则重试失败的阶段 */
  async function retryStage(stage?: Stage) {
    const id = docIdRef.current;
    if (!id) return;
    const target = stage ?? STAGES.find((s) => doc?.stages[s].status === 'failed');
    if (!target) return;
    setBusy((prev) => ({ ...prev, [target]: true }));
    try {
      const res = await fetch(`/api/pipeline/${id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: target }),
      });
      if (!res.ok) setError(await res.text());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((prev) => ({ ...prev, [target]: false }));
    }
  }

  /** AI 修复/修改：带反馈重新生成。feedback 省略则自动用 error（自动修复） */
  async function repairStage(stage: Stage, feedback?: string) {
    const id = docIdRef.current;
    if (!id) return;
    setBusy((prev) => ({ ...prev, [stage]: true }));
    try {
      const res = await fetch(`/api/pipeline/${id}/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage, feedback: feedback?.trim() }),
      });
      if (!res.ok) setError(await res.text());
      else {
        setRepairOpen(null);
        setRepairText('');
        // completed 任务修改后 SSE 已关闭（done 事件里 es.close），重新订阅以接收后续进度
        subscribe(id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((prev) => ({ ...prev, [stage]: false }));
    }
  }

  /** 断开订阅（任务仍在后台执行，仅停止实时跟踪） */
  function disconnect() {
    esRef.current?.close();
    esRef.current = null;
    docIdRef.current = null;
    sessionStorage.removeItem('apploom:lastPipeline');
    setDoc(null);
    setTokens(emptyTokens());
    setConnected(false);
    setError('已断开实时连接，任务仍在后台执行。');
  }

  /** 加载历史项目列表 */
  async function loadHistory() {
    try {
      const res = await fetch('/api/pipeline');
      if (!res.ok) { setError(await res.text()); return; }
      const { items } = await res.json();
      setHistory(items as PipelineDocSummary[]);
      setShowHistory(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** 打开历史项目：加载完整 doc；未完成则重新订阅，已完成仅展示 */
  function openHistory(id: string) {
    esRef.current?.close();
    (async () => {
      try {
        const res = await fetch(`/api/pipeline/${id}`);
        if (!res.ok) { setError(await res.text()); return; }
        const d = (await res.json()) as PipelineDoc;
        setDoc(d);
        setTokens(emptyTokens());
        setShowHistory(false);
        docIdRef.current = id;
        sessionStorage.setItem('apploom:lastPipeline', id);
        if (d.status === 'completed' || d.status === 'failed') {
          setConnected(false);
        } else {
          subscribe(id);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }

  // 挂载时恢复上次未完成的任务（页面刷新后能续上）
  useEffect(() => {
    const id = sessionStorage.getItem('apploom:lastPipeline');
    if (!id) return;
    (async () => {
      try {
        const res = await fetch(`/api/pipeline/${id}`);
        if (!res.ok) { sessionStorage.removeItem('apploom:lastPipeline'); return; }
        const d = (await res.json()) as PipelineDoc;
        if (d.status === 'completed') {
          setDoc(d);
          sessionStorage.removeItem('apploom:lastPipeline');
        } else {
          setDoc(d);
          subscribe(id);
        }
      } catch { /* 后端没起来时静默跳过 */ }
    })();
    return () => esRef.current?.close();
  }, [subscribe]);

  // ===== 派生状态 =====
  const statusOf = (s: Stage): Status => toStatus(doc?.stages[s]?.status);
  const isRunning = doc?.status === 'running';
  const isWaiting = doc?.status === 'waiting_confirm';
  const isFailed = doc?.status === 'failed';
  const isCompleted = doc?.status === 'completed';
  const activeStage = doc?.currentStage ?? null;
  const activeRunning = activeStage !== null && statusOf(activeStage) === 'running';
  const streaming = activeStage ? tokens[activeStage] : '';

  const prd = doc?.stages.requirement.result as PRD | undefined;
  const prototype = doc?.stages.prototype.result as Prototype | undefined;
  const design = doc?.stages.design.result as Design | undefined;
  const codegen = doc?.stages.codegen.result as Codegen | undefined;
  const deploy = doc?.stages.deploy.result as Deploy | undefined;

  const canStart = !doc || isCompleted || isFailed;
  const previewLabel = deploy ? 'DeployDocument' : codegen ? 'CodegenDocument' : design ? 'DesignDocument' : prototype ? 'PrototypeDocument' : prd ? 'PRD' : '待生成';
  const showStream = activeRunning;

  /** 对话式修改输入框（done / waiting_confirm / error 状态通用） */
  const repairEntry = (stage: Stage) => (
    <div className="repair-box">
      <textarea
        className="ta repair-ta"
        placeholder={`用一句话告诉 AI 怎么改「${STAGE_LABEL[stage]}」，例如：改成深色主题 / 去掉 XX 功能 / 修复报错：xxx。留空则直接重新生成`}
        value={repairText}
        onChange={(e) => setRepairText(e.target.value)}
        autoFocus
      />
      <div className="row">
        <button className="btn btn-primary" onClick={() => repairStage(stage, repairText)} disabled={busy[stage]}>
          {busy[stage] ? '提交中…' : (repairText.trim() ? '提交修改' : '直接重新生成')}
        </button>
        <button className="btn btn-ghost" onClick={() => { setRepairOpen(null); setRepairText(''); }}>取消</button>
      </div>
    </div>
  );

  return (
    <div className="page">
      <header className="topbar">
        <span className="logo">🚀 AppLoom · Studio</span>
        <span className="sub">
          生产端 · 异步 5-Agent 流水线（BullMQ + SSE）
          {connected && <span style={{ color: '#10b981', marginLeft: 6 }}>● 实时连接</span>}
        </span>
        <button className="btn btn-ghost" onClick={loadHistory}>📚 历史项目</button>
      </header>

      <ApprovalPanel approvals={approvals} onDecide={decideApproval} />

      {/* 历史项目面板 */}
      {showHistory && (
        <div className="history-overlay" onClick={() => setShowHistory(false)}>
          <div className="history-panel" onClick={(e) => e.stopPropagation()}>
            <div className="history-head">
              <span>📚 历史项目（{history.length}）</span>
              <button className="btn btn-ghost" onClick={() => setShowHistory(false)}>关闭</button>
            </div>
            <div className="history-list">
              {history.length === 0 && <p className="ph">还没有历史项目</p>}
              {history.map((h) => (
                <div key={h.id} className="history-item" onClick={() => openHistory(h.id)}>
                  <div className="history-item-head">
                    <span className="history-req">{h.requirement}</span>
                    <span className={`badge badge-${pipelineBadge(h.status)}`}>{pipelineStatusLabel(h.status)}</span>
                  </div>
                  <div className="history-item-meta">
                    <span>{new Date(h.updatedAt).toLocaleString()}</span>
                    <span className="history-steps">
                      {STAGES.map((s) => (
                        <i key={s} className={`dot dot-${toStatus(h.stages[s])}`} title={`${STAGE_LABEL[s]}: ${statusLabel(toStatus(h.stages[s]))}`} />
                      ))}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 全宽状态 Banner */}
      {doc && (
        <div className={`banner ${isWaiting ? 'banner-wait' : isFailed ? 'banner-fail' : isCompleted ? 'banner-done' : 'banner-run'}`}>
          {isRunning && (
            <>
              <span className="banner-spin" />
              <span>
                ⏳ 正在生成 <b style={{ marginLeft: 4 }}>{activeStage ? STAGE_LABEL[activeStage] : '流水线'}</b>
                · 已接收 <b style={{ marginLeft: 4 }}>{streaming.length}</b> 字符
              </span>
              <button className="banner-btn" onClick={disconnect}>断开</button>
            </>
          )}
          {isWaiting && (
            <>
              <span>⏸ 等待确认：<b>{activeStage ? STAGE_LABEL[activeStage] : ''}</b> 已完成</span>
              <button
                className="banner-btn banner-btn-confirm"
                onClick={() => activeStage && confirmStage(activeStage)}
                disabled={!activeStage || busy[activeStage]}
              >
                {activeStage
                  ? `确认继续 → ${STAGE_LABEL[STAGES[Math.min(STAGES.indexOf(activeStage) + 1, STAGES.length - 1)]]}`
                  : '确认'}
              </button>
            </>
          )}
          {isFailed && (
            <>
              <span>✗ 流水线失败：<b>{activeStage ? STAGE_LABEL[activeStage] : ''}</b></span>
              <button className="banner-btn banner-btn-retry" onClick={() => retryStage()} disabled={busy[activeStage ?? 'requirement']}>
                重试失败阶段
              </button>
            </>
          )}
          {isCompleted && <span>✓ 全部完成 —— 5 个 Agent 已产出完整交付物</span>}
        </div>
      )}

      <div className="layout">
        {/* 左：输入 + 流水线 */}
        <main className="main">
          <section className="input-card">
            <label className="lbl">一句话需求</label>
            <textarea
              className="ta"
              placeholder="例如：做一个团队待办事项应用，支持任务指派和看板"
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              disabled={!canStart}
            />
            <div className="row">
              <button className="btn btn-primary" onClick={start} disabled={!canStart || !requirement.trim()}>
                {doc && isCompleted ? '重新生成' : '生成 PRD →'}
              </button>
              <label className="confirm-toggle">
                <input
                  type="checkbox"
                  checked={confirmMode}
                  onChange={(e) => setConfirmMode(e.target.checked)}
                  disabled={!canStart}
                />
                逐步确认（每步暂停等你确认）
              </label>
            </div>
            {isRunning && activeStage && (
              <div className="run-hint">
                <span className="banner-spin" />
                <span>◐ 正在执行：<b>{STAGE_LABEL[activeStage]}</b> · 已接收 <b>{streaming.length}</b> 字符</span>
              </div>
            )}
            {isWaiting && activeStage && (
              <div className="run-hint wait-hint">
                <span>⏸ <b>{STAGE_LABEL[activeStage]}</b> 已完成，点击卡片或上方按钮确认继续</span>
              </div>
            )}
          </section>

          <div className="pipeline">
            {STAGES.map((stage, i) => {
              const st = statusOf(stage);
              const stageState = doc?.stages[stage];
              return (
                <div key={stage}>
                  <div className={`stage stage-${st}`}>
                    <div className="stage-head">
                      <span className="stage-num">{statusIcon(st, i + 1)}</span>
                      <span className="stage-title">{STAGE_LABEL[stage]}</span>
                      <span className={`badge badge-${st}`}>{statusLabel(st)}</span>
                      {stageState?.llmLogs && stageState.llmLogs.length > 0 && (
                        <button className="btn btn-log" onClick={() => setLogOpen(logOpen === stage ? null : stage)}>
                          🐞 日志
                        </button>
                      )}
                    </div>
                    {logOpen === stage && stageState?.llmLogs && (
                      <LlmLogPanel logs={stageState.llmLogs} />
                    )}
                    {st === 'running' && <StageLoading stage={stage} streaming={tokens[stage]} />}
                    {st === 'waiting_confirm' && (
                      <div className="stage-body">
                        <div className="confirm-box">
                          <span>✅ 本阶段已完成，确认后进入下一阶段</span>
                          <div className="row">
                            <button className="btn btn-edit" onClick={() => { setRepairOpen(repairOpen === stage ? null : stage); setRepairText(''); }}>
                              ✏ 修改
                            </button>
                            <button className="btn btn-confirm" onClick={() => confirmStage(stage)} disabled={busy[stage]}>
                              {busy[stage] ? '确认中…' : '确认继续 →'}
                            </button>
                          </div>
                        </div>
                        {repairOpen === stage && repairEntry(stage)}
                      </div>
                    )}
                    {st === 'error' && (
                      <div className="stage-body">
                        <div className="confirm-box fail-box">
                          <span className="fail-text">
                            ❌ {stageState?.error || '执行失败'}
                            {errorClassMeta(stageState?.errorClass) && (
                              <span className="fail-class" data-testid="error-class">
                                <b className="badge badge-error">{errorClassMeta(stageState?.errorClass)!.label}</b>
                                <i>{errorClassMeta(stageState?.errorClass)!.hint}</i>
                              </span>
                            )}
                          </span>
                          <div className="row">
                            <button className="btn btn-edit" onClick={() => {
                              // 失败时默认用 error 信息作为反馈预填，用户可改或留空
                              setRepairOpen(repairOpen === stage ? null : stage);
                              setRepairText(stageState?.error ?? '');
                            }}>
                              ✏ 修改
                            </button>
                            <button className="btn btn-retry" onClick={() => retryStage(stage)} disabled={busy[stage]}>
                              {busy[stage] ? '重试中…' : '重试'}
                            </button>
                          </div>
                        </div>
                        {repairOpen === stage && repairEntry(stage)}
                      </div>
                    )}
                    {st === 'done' && (
                      <div className="stage-body">
                        <div className="stage-actions">
                          <button className="btn btn-edit" onClick={() => { setRepairOpen(repairOpen === stage ? null : stage); setRepairText(''); }}>
                            ✏ 修改
                          </button>
                        </div>
                        {repairOpen === stage && repairEntry(stage)}
                      </div>
                    )}
                    {stageMeta(stage, prd, prototype, design, codegen, deploy)}
                  </div>
                  {i < STAGES.length - 1 && <div className="connector" />}
                </div>
              );
            })}
          </div>

          {error && <div className="err">⚠ {error}</div>}
        </main>

        {/* 右：产出预览 */}
        <aside className="preview">
          <header className="pv-header">
            <span>产出预览</span>
            <span className="pv-sub">
              {showStream ? (
                <span className="studio-pv-streaming">
                  <span className="studio-dot-pulse" />
                  生成中 · {streaming.length} 字符
                </span>
              ) : previewLabel}
            </span>
          </header>
          <div className="pv-body">
            {showStream ? (
              <div>
                <div className="raw-banner">
                  <span className="banner-spin" />
                  <span>生成中 · 已接收 {streaming.length} 字符</span>
                </div>
                <pre className="raw">
                  {streaming || '等待模型响应…'}
                  <span className="studio-cursor-blink">▋</span>
                </pre>
              </div>
            ) : deploy ? (
              <DeployView deploy={deploy} />
            ) : codegen ? (
              <CodegenView codegen={codegen} />
            ) : design ? (
              <DesignView design={design} />
            ) : prototype ? (
              <PrototypeView prototype={prototype} />
            ) : prd ? (
              <PrdView prd={prd} />
            ) : (
              <p className="ph">输入一句话需求，依次经过 5 个 Agent：需求拆解 → 产品原型 → 方案设计 → 代码生成 → 部署发布。</p>
            )}
          </div>
        </aside>
      </div>

      <style>{`
        .page { height:100vh; display:flex; flex-direction:column; background:#f7f8fa; color:#1a1a2e; font-family:-apple-system,'PingFang SC',sans-serif; }
        .topbar { display:flex; align-items:center; justify-content:space-between; padding:12px 24px; background:#fff; border-bottom:1px solid #e5e7eb; }
        .logo { font-weight:700; font-size:15px; }
        .sub { font-size:12px; color:#9ca3af; flex:1; }
        .history-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.35); display:flex; align-items:flex-start; justify-content:center; padding-top:80px; z-index:200; }
        .history-panel { width:560px; max-height:70vh; background:#fff; border-radius:14px; box-shadow:0 12px 40px rgba(0,0,0,0.2); display:flex; flex-direction:column; overflow:hidden; }
        .history-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #e5e7eb; font-size:14px; font-weight:600; }
        .history-list { flex:1; overflow-y:auto; padding:8px; }
        .history-item { padding:12px 14px; border-radius:10px; cursor:pointer; border:1px solid transparent; }
        .history-item:hover { background:#f8fafc; border-color:#e2e8f0; }
        .history-item-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .history-req { font-size:13px; font-weight:600; color:#1a1a2e; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .history-item-meta { display:flex; align-items:center; justify-content:space-between; margin-top:8px; font-size:11px; color:#9ca3af; }
        .history-steps { display:flex; gap:4px; }
        .dot { width:8px; height:8px; border-radius:50%; background:#e5e7eb; display:inline-block; }
        .dot-done { background:#10b981; }
        .dot-running { background:#3b82f6; }
        .dot-error { background:#ef4444; }
        .dot-waiting_confirm { background:#f59e0b; }
        .layout { flex:1; display:flex; overflow:hidden; }
        .main { flex:1; overflow-y:auto; padding:24px; display:flex; flex-direction:column; gap:16px; max-width:680px; }
        .input-card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:10px; }
        .lbl { font-size:12px; color:#6b7280; font-weight:600; }
        .ta { width:100%; min-height:80px; resize:vertical; padding:10px 12px; border:1px solid #e5e7eb; border-radius:8px; font-size:14px; line-height:1.6; font-family:inherit; box-sizing:border-box; }
        .ta:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px #eff6ff; }
        .row { display:flex; gap:8px; align-items:center; }
        .btn { border:none; border-radius:8px; padding:8px 16px; font-size:13px; cursor:pointer; font-weight:500; }
        .btn-primary { background:#3b82f6; color:#fff; }
        .btn-primary:hover { background:#2563eb; }
        .btn-primary:disabled { background:#d1d5db; cursor:not-allowed; }
        .btn-confirm { background:#f59e0b; color:#fff; }
        .btn-confirm:hover { background:#d97706; }
        .btn-confirm:disabled { background:#d1d5db; cursor:not-allowed; }
        .btn-retry { background:#ef4444; color:#fff; }
        .btn-retry:hover { background:#dc2626; }
        .btn-retry:disabled { background:#d1d5db; cursor:not-allowed; }
        .btn-ai-fix { background:#10b981; color:#fff; }
        .btn-ai-fix:hover { background:#059669; }
        .btn-ai-fix:disabled { background:#d1d5db; cursor:not-allowed; }
        .btn-edit { background:#f0f1f3; color:#6b7280; }
        .btn-edit:hover { background:#e5e7eb; }
        .btn-ghost { background:transparent; color:#6b7280; border:1px solid #e5e7eb; }
        .btn-ghost:hover { background:#f0f1f3; }
        .confirm-toggle { margin-left:8px; font-size:12px; color:#6b7280; display:flex; align-items:center; gap:6px; cursor:pointer; }
        .confirm-toggle input { accent-color:#3b82f6; }

        .banner { padding:14px 24px; color:#fff; font-size:15px; font-weight:600; text-align:center; display:flex; align-items:center; justify-content:center; gap:12px; box-shadow:0 2px 8px rgba(0,0,0,0.12); position:sticky; top:0; z-index:100; }
        .banner-run { background:linear-gradient(90deg,#3b82f6,#2563eb); }
        .banner-wait { background:linear-gradient(90deg,#f59e0b,#d97706); }
        .banner-fail { background:linear-gradient(90deg,#ef4444,#dc2626); }
        .banner-done { background:linear-gradient(90deg,#10b981,#059669); }
        .banner-spin { width:18px; height:18px; border:3px solid rgba(255,255,255,0.4); border-top-color:#fff; border-radius:50%; display:inline-block; flex-shrink:0; animation:studio-spin 0.8s linear infinite; }
        .banner-btn { padding:6px 14px; border:1px solid rgba(255,255,255,0.5); background:rgba(255,255,255,0.15); border-radius:8px; color:#fff; font-size:13px; cursor:pointer; font-weight:600; }
        .banner-btn:hover { background:rgba(255,255,255,0.3); }
        .banner-btn:disabled { opacity:0.6; cursor:not-allowed; }
        .banner-btn-confirm { background:#fff; color:#d97706; border-color:#fff; }
        .banner-btn-confirm:hover { background:#fef3c7; }
        .banner-btn-retry { background:#fff; color:#dc2626; border-color:#fff; }
        .banner-btn-retry:hover { background:#fef2f2; }

        .run-hint { margin-top:12px; padding:12px 14px; background:#eff6ff; border:2px solid #3b82f6; border-radius:10px; font-size:13px; color:#1e40af; display:flex; align-items:center; gap:10px; font-weight:500; }
        .run-hint .banner-spin { width:16px; height:16px; border-width:2px; }
        .wait-hint { background:#fffbeb; border-color:#f59e0b; color:#92400e; }
        .raw-banner { margin-bottom:12px; padding:10px 12px; background:#eff6ff; border-radius:8px; border:1px solid #bfdbfe; font-size:12px; color:#3b82f6; display:flex; align-items:center; gap:8px; }
        .raw-banner .banner-spin { width:14px; height:14px; border-width:2px; }

        .pipeline { display:flex; flex-direction:column; align-items:stretch; }
        .stage { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px 16px; }
        .stage-pending { opacity:0.6; }
        .stage-running { border-color:#3b82f6; box-shadow:0 0 0 3px #eff6ff; }
        .stage-done { border-color:#10b981; }
        .stage-error { border-color:#ef4444; }
        .stage-waiting_confirm { border-color:#f59e0b; box-shadow:0 0 0 3px #fef3c7; }
        .stage-head { display:flex; align-items:center; gap:10px; }
        .stage-num { width:24px; height:24px; border-radius:50%; background:#f0f1f3; color:#6b7280; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
        .stage-running .stage-num { background:#3b82f6; color:#fff; animation:studio-spin 1.2s linear infinite; }
        .stage-done .stage-num { background:#10b981; color:#fff; }
        .stage-error .stage-num { background:#ef4444; color:#fff; }
        .stage-waiting_confirm .stage-num { background:#f59e0b; color:#fff; }
        .stage-title { font-weight:600; font-size:14px; flex:1; }
        .badge { font-size:11px; padding:2px 8px; border-radius:999px; }
        .badge-pending { background:#f0f1f3; color:#6b7280; }
        .badge-running { background:#eff6ff; color:#3b82f6; }
        .badge-done { background:#ecfdf5; color:#10b981; }
        .badge-error { background:#fef2f2; color:#ef4444; }
        .badge-waiting_confirm { background:#fef3c7; color:#f59e0b; }
        .stage-body { margin-top:10px; display:flex; flex-direction:column; gap:10px; }
        .confirm-box { display:flex; align-items:center; justify-content:space-between; gap:10px; background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; padding:10px 12px; font-size:12px; color:#92400e; }
        .fail-box { background:#fef2f2; border-color:#fca5a5; color:#991b1b; }
        .fail-text { display:flex; flex-direction:column; gap:6px; flex:1; min-width:0; word-break:break-word; white-space:pre-wrap; }
        .fail-class { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; font-size:11px; color:#7f1d1d; white-space:normal; }
        .fail-class b { flex:none; white-space:nowrap; }
        .fail-class i { font-style:normal; opacity:.85; flex:1 1 160px; min-width:0; }
        .fail-box .row { flex:none; }
        .fail-box .btn { white-space:nowrap; }
        .stage-actions { display:flex; justify-content:flex-end; }
        .repair-box { display:flex; flex-direction:column; gap:8px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px; }
        .repair-ta { min-height:64px; font-size:13px; }
        .btn-log { background:#f0f1f3; color:#6b7280; padding:4px 10px; font-size:11px; margin-left:auto; }
        .btn-log:hover { background:#e5e7eb; }
        .llm-log-panel { display:flex; flex-direction:column; gap:10px; margin-top:10px; }
        .llm-log-entry { border:1px solid #e5e7eb; border-radius:8px; padding:10px; background:#fafafa; }
        .llm-log-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
        .llm-log-label { font-size:11px; font-weight:700; color:#6d28d9; background:#ede9fe; padding:2px 8px; border-radius:999px; }
        .llm-log-ts { font-size:10px; color:#9ca3af; }
        .llm-log-section { margin-top:6px; }
        .llm-log-title { font-size:11px; color:#6b7280; font-weight:600; margin-bottom:4px; }
        .llm-log-pre { font-family:'SF Mono',monospace; font-size:10px; line-height:1.5; white-space:pre-wrap; word-break:break-all; color:#374151; background:#fff; border:1px solid #e5e7eb; border-radius:6px; padding:6px 8px; margin:0; max-height:200px; overflow-y:auto; }
        .meta-row { display:flex; gap:16px; font-size:12px; color:#6b7280; }
        .meta-row .ok { color:#10b981; font-weight:600; }
        .meta-row .fail { color:#ef4444; font-weight:600; }
        .techstack { display:flex; flex-wrap:wrap; gap:6px; }
        .tk { font-size:11px; padding:3px 8px; background:#eff6ff; color:#3b82f6; border-radius:6px; border:1px solid #93c5fd; }
        .connector { width:2px; height:20px; background:#e5e7eb; margin-left:24px; align-self:flex-start; }
        .err { font-size:12px; color:#ef4444; background:#fef2f2; border:1px solid #fca5a5; border-radius:8px; padding:10px 12px; }

        .preview { width:400px; background:#fff; border-left:1px solid #e5e7eb; display:flex; flex-direction:column; flex-shrink:0; }
        .pv-header { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-bottom:1px solid #e5e7eb; font-size:14px; font-weight:600; }
        .pv-sub { font-size:12px; color:#9ca3af; font-weight:400; }
        .studio-pv-streaming { display:inline-flex; align-items:center; gap:6px; color:#3b82f6; }
        .studio-dot-pulse { width:8px; height:8px; border-radius:50%; background:#3b82f6; display:inline-block; animation:studio-blink 1s step-end infinite; }
        .pv-body { flex:1; overflow-y:auto; padding:16px 18px; }
        .ph { color:#9ca3af; font-size:13px; line-height:1.7; }
        .raw { font-family:'SF Mono',monospace; font-size:11px; white-space:pre-wrap; word-break:break-all; color:#374151; margin:0; line-height:1.6; }
        .pv-body section { margin-bottom:16px; }
        .pv-body h4 { margin:0 0 6px; font-size:12px; font-weight:600; }
        .pv-body p { margin:0; font-size:12px; line-height:1.6; color:#374151; }
        .pv-body ul { margin:0; padding-left:16px; }
        .pv-body li { font-size:12px; line-height:1.6; color:#374151; }
        .tags { display:flex; flex-wrap:wrap; gap:4px; }
        .tag { font-size:11px; padding:2px 7px; background:#f0f1f3; border-radius:5px; color:#6b7280; }
        table.ft { width:100%; border-collapse:collapse; font-size:11px; }
        table.ft th, table.ft td { border:1px solid #e5e7eb; padding:4px 6px; text-align:left; }
        table.ft th { background:#f7f8fa; }
        .prio { display:inline-block; padding:1px 5px; border:1px solid; border-radius:3px; font-size:10px; font-weight:600; }
        .file-tree { font-family:'SF Mono',monospace; font-size:11px; }
        .file-item { padding:3px 0; cursor:pointer; color:#3b82f6; }
        .file-item:hover { text-decoration:underline; }
        .code-block { font-family:'SF Mono',monospace; font-size:10px; background:#f7f8fa; border:1px solid #e5e7eb; border-radius:6px; padding:8px; overflow-x:auto; white-space:pre; max-height:200px; overflow-y:auto; }
        .deploy-success { color:#10b981; font-weight:600; }
        .deploy-failed { color:#ef4444; font-weight:600; }
        .build-log { font-family:'SF Mono',monospace; font-size:11px; background:#1a1a2e; color:#a7f3d0; border-radius:6px; padding:10px; white-space:pre-wrap; word-break:break-all; }

        /* === 产品原型 HTML 预览 === */
        .proto-frame { width:100%; height:480px; border:1px solid #e5e7eb; border-radius:10px; background:#fff; }
        .flow-item { padding:8px 10px; border:1px solid #e5e7eb; border-radius:8px; margin-bottom:8px; }
        .flow-item b { font-size:12px; color:#1a1a2e; }
        .flow-desc { font-size:11px; color:#6b7280; margin-left:8px; }

        @keyframes studio-spin { to { transform:rotate(360deg); } }
        @keyframes studio-blink { 0%,50% { opacity:1; } 51%,100% { opacity:0; } }
      `}</style>
    </div>
  );
}

function statusLabel(s: Status) {
  return { pending: '待执行', running: '生成中', done: '已完成', error: '失败', waiting_confirm: '待确认' }[s];
}

/** 任务整体状态 → 中文标签 */
function pipelineStatusLabel(s: PipelineStatus) {
  return { created: '待执行', running: '进行中', waiting_confirm: '待确认', failed: '失败', completed: '已完成' }[s];
}

/** 任务整体状态 → 前端 badge 样式类 */
function pipelineBadge(s: PipelineStatus): Status {
  return ({ created: 'pending', running: 'running', waiting_confirm: 'waiting_confirm', failed: 'error', completed: 'done' } as Record<PipelineStatus, Status>)[s];
}

function statusIcon(s: Status, num: number) {
  if (s === 'done') return '✓';
  if (s === 'running') return '◐';
  if (s === 'error') return '✕';
  if (s === 'waiting_confirm') return '⏸';
  return num;
}

/** 各阶段卡片摘要行（数据来自后端 doc.stages[stage].result） */
function stageMeta(stage: Stage, prd?: PRD, prototype?: Prototype, design?: Design, codegen?: Codegen, deploy?: Deploy) {
  if (stage === 'requirement' && prd) {
    return (
      <div className="stage-body">
        <div className="meta-row">
          <span>功能 {prd.features.length}</span>
          <span>P0 {prd.features.filter((f) => f.priority === 'P0').length}</span>
          <span>假设 {prd.assumptions.length}</span>
          <span>实体 {prd.entities.length}</span>
        </div>
      </div>
    );
  }
  if (stage === 'prototype' && prototype) {
    return (
      <div className="stage-body">
        <div className="meta-row">
          <span>页面 {prototype.pages.length}</span>
          <span>流程 {prototype.flows.length}</span>
          <span>HTML {Math.round(prototype.html.length / 1024)}KB</span>
        </div>
      </div>
    );
  }
  if (stage === 'design' && design) {
    return (
      <div className="stage-body">
        <div className="techstack">
          {design.techStack.map((t) => <span key={t} className="tk">{t}</span>)}
        </div>
        <div className="meta-row">
          <span>页面 {design.pageTree.length}</span>
          <span>实体 {design.dataModels.length}</span>
          <span>API {design.apis.length}</span>
        </div>
      </div>
    );
  }
  if (stage === 'codegen' && codegen) {
    return (
      <div className="stage-body">
        <div className="meta-row">
          <span>文件 {codegen.files.length}</span>
          <span>依赖 {codegen.dependencies.length}</span>
          <span>注意 {codegen.notes.length}</span>
        </div>
      </div>
    );
  }
  if (stage === 'deploy' && deploy) {
    return (
      <div className="stage-body">
        <div className="meta-row">
          <span>目标 {deploy.target === 'local' ? '本地' : deploy.target === 'cloud' ? '云托管' : 'Git 导出'}</span>
          <span className={deploy.status === 'success' ? 'ok' : 'fail'}>
            {deploy.status === 'success' ? '✓ 成功' : '✗ 失败'}
          </span>
          {deploy.url && <a className="deploy-url" href={deploy.url} target="_blank" rel="noopener noreferrer">{deploy.url}</a>}
        </div>
      </div>
    );
  }
  return null;
}

const STAGE_STEPS: Record<Stage, string[]> = {
  requirement: ['解析一句话需求', '识别目标用户与场景', '拆解功能与优先级', '抽取数据实体', '生成假设与验收点'],
  prototype: ['阅读 PRD 页面清单', '设计页面布局区块', '拆解组件与文案', '梳理核心用户流程', '定义交互跳转关系'],
  design: ['阅读 PRD 与原型', '决策技术栈', '设计页面路由', '设计数据模型', '设计 API 接口'],
  codegen: ['阅读 Design 与原型', '规划文件结构', '生成页面组件', '生成 API 路由', '生成配置与依赖'],
  deploy: ['阅读 Codegen', '准备构建环境', '安装依赖', '执行构建', '发布到云端'],
};

function StageLoading({ stage, streaming }: { stage: Stage; streaming: string }) {
  const steps = STAGE_STEPS[stage];
  // 根据已接收字符数估算进度（每步约 200 字符推进）
  const progress = Math.min(steps.length, Math.floor(streaming.length / 200) + 1);
  return (
    <div className="studio-stage-loading" style={{
      marginTop: 12, padding: 12, background: '#f8faff', border: '2px solid #3b82f6', borderRadius: 8,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{
          width: 18, height: 18, border: '2px solid #bfdbfe', borderTopColor: '#3b82f6',
          borderRadius: '50%', display: 'inline-block', flexShrink: 0, marginTop: 2,
          animation: 'studio-spin 0.8s linear infinite',
        }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {steps.map((s, i) => {
            const color = i < progress ? '#10b981' : i === progress ? '#3b82f6' : '#9ca3af';
            return (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color }}>
                <span style={{ width: 14, textAlign: 'center' }}>
                  {i < progress ? '✓' : i === progress ? '●' : '○'}
                </span>
                <span>{s}</span>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', minWidth: 80 }}>
          <span style={{ fontSize: 10, color: '#6b7280', fontFamily: 'SF Mono,monospace' }}>{streaming.length} 字符</span>
          <div style={{ width: 80, height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${(progress / steps.length) * 100}%`,
              background: 'linear-gradient(90deg,#3b82f6,#60a5fa)', borderRadius: 2, transition: 'width 0.4s ease',
            }} />
          </div>
        </div>
      </div>
      {streaming && (
        <div style={{
          fontFamily: 'SF Mono,monospace', fontSize: 10, lineHeight: 1.5, color: '#6b7280',
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 8px',
          maxHeight: 60, overflow: 'hidden', wordBreak: 'break-all',
        }}>
          <span style={{ color: '#3b82f6', fontWeight: 600 }}>实时输出：</span>
          <span style={{ color: '#9ca3af' }}>{streaming.slice(-120)}</span>
          <span style={{ display: 'inline-block', color: '#3b82f6', animation: 'studio-blink 1s step-end infinite' }}>▋</span>
        </div>
      )}
    </div>
  );
}

/** LLM 调试日志面板：展示该阶段每次 LLM 调用的 user prompt（含 repair 反馈）与响应 */
function LlmLogPanel({ logs }: { logs: LlmLogEntry[] }) {
  return (
    <div className="llm-log-panel">
      {logs.map((log, i) => (
        <div key={i} className="llm-log-entry">
          <div className="llm-log-head">
            <span className="llm-log-label">{log.label}</span>
            <span className="llm-log-ts">{new Date(log.ts).toLocaleTimeString()}</span>
          </div>
          <div className="llm-log-section">
            <div className="llm-log-title">→ user（请求）</div>
            <pre className="llm-log-pre">{log.user}</pre>
          </div>
          <div className="llm-log-section">
            <div className="llm-log-title">← response（响应）</div>
            <pre className="llm-log-pre">{log.response}</pre>
          </div>
        </div>
      ))}
    </div>
  );
}

function PrdView({ prd }: { prd: PRD }) {
  const PC = { P0: '#ef4444', P1: '#f59e0b', P2: '#8b5cf6' };
  return (
    <div>
      <section><h4>概述</h4><p>{prd.overview}</p></section>
      <section><h4>目标用户</h4><div className="tags">{prd.targetUsers.map((u) => <span key={u} className="tag">{u}</span>)}</div></section>
      <section><h4>功能 ({prd.features.length})</h4>
        <table className="ft">
          <thead><tr><th>ID</th><th>功能</th><th>优先级</th><th>说明</th></tr></thead>
          <tbody>
            {prd.features.map((f) => (
              <tr key={f.id}><td>{f.id}</td><td>{f.name}</td>
                <td><span className="prio" style={{ color: PC[f.priority], borderColor: PC[f.priority] }}>{f.priority}</span></td>
                <td>{f.desc}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section><h4>页面</h4><div className="tags">{prd.pages.map((p) => <span key={p} className="tag">{p}</span>)}</div></section>
      <section><h4>实体</h4><ul>{prd.entities.map((e) => <li key={e.name}><b>{e.name}</b>: {e.fields.join(', ')}</li>)}</ul></section>
      <section><h4>假设</h4><ul>{prd.assumptions.map((a, i) => <li key={i} style={{ color: '#92400e' }}>{a}</li>)}</ul></section>
    </div>
  );
}

function DesignView({ design }: { design: Design }) {
  return (
    <div>
      <section><h4>技术栈</h4><div className="tags">{design.techStack.map((t) => <span key={t} className="tag" style={{ background: '#eff6ff', color: '#3b82f6' }}>{t}</span>)}</div></section>
      <section><h4>架构说明</h4><p>{design.architecture}</p></section>
      <section><h4>页面树 ({design.pageTree.length})</h4>
        <ul>{design.pageTree.map((p) => <li key={p.path}><code>{p.path}</code> → {p.component}（{p.description}）</li>)}</ul>
      </section>
      <section><h4>数据模型 ({design.dataModels.length})</h4>
        <ul>{design.dataModels.map((e) => <li key={e.name}><b>{e.name}</b>: {e.fields.map((f) => `${f.name}:${f.type}`).join(', ')}</li>)}</ul>
      </section>
      <section><h4>API ({design.apis.length})</h4>
        <table className="ft">
          <thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead>
          <tbody>{design.apis.map((a, i) => <tr key={i}><td>{a.method}</td><td><code>{a.path}</code></td><td>{a.description}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}

function CodegenView({ codegen }: { codegen: Codegen }) {
  const [selectedFile, setSelectedFile] = useState<number | null>(0);
  return (
    <div>
      <section><h4>文件 ({codegen.files.length})</h4>
        <div className="file-tree">
          {codegen.files.map((f, i) => (
            <div key={i} className="file-item" onClick={() => setSelectedFile(i)}>
              {selectedFile === i ? '▸' : '▹'} {f.path}
            </div>
          ))}
        </div>
      </section>
      {selectedFile !== null && codegen.files[selectedFile] && (
        <section>
          <h4>{codegen.files[selectedFile].path}</h4>
          <div className="code-block">{codegen.files[selectedFile].content}</div>
        </section>
      )}
      <section><h4>依赖 ({codegen.dependencies.length})</h4>
        <div className="tags">{codegen.dependencies.map((d) => <span key={d} className="tag" style={{ background: '#fef3c7', color: '#92400e' }}>{d}</span>)}</div>
      </section>
      <section><h4>启动命令</h4><code style={{ fontSize: 12 }}>{codegen.runCommand}</code></section>
      {codegen.notes.length > 0 && (
        <section><h4>注意事项</h4><ul>{codegen.notes.map((n, i) => <li key={i} style={{ color: '#92400e' }}>{n}</li>)}</ul></section>
      )}
    </div>
  );
}

function DeployView({ deploy }: { deploy: Deploy }) {
  return (
    <div>
      <section><h4>部署状态</h4>
        <p className={deploy.status === 'success' ? 'deploy-success' : 'deploy-failed'}>
          {deploy.status === 'success' ? '✓ 部署成功' : '✗ 部署失败'}
        </p>
      </section>
      <section><h4>部署目标</h4>
        <p>{deploy.target === 'local' ? '💻 本地真部署（dev server 已启动）' : deploy.target === 'cloud' ? '☁ 内置云托管' : '📦 Git 仓库导出'}</p>
      </section>
      {deploy.url && (
        <section><h4>访问地址</h4>
          <a href={deploy.url} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', fontSize: 12, wordBreak: 'break-all' }}>{deploy.url}</a>
        </section>
      )}
      {deploy.repoUrl && (
        <section><h4>仓库链接</h4>
          <a href={deploy.repoUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', fontSize: 12, wordBreak: 'break-all' }}>{deploy.repoUrl}</a>
        </section>
      )}
      <section><h4>构建日志</h4>
        <div className="build-log">{deploy.buildLog}</div>
      </section>
    </div>
  );
}

/** 产品原型线框稿渲染：可切换页面查看布局，区块/组件用占位块呈现 */
function PrototypeView({ prototype }: { prototype: Prototype }) {
  return (
    <div>
      <section>
        <h4>应用</h4>
        <p><b>{prototype.appName}</b> · {prototype.designStyle}</p>
      </section>
      <section>
        <h4>页面 ({prototype.pages.length})</h4>
        <div className="tags">
          {prototype.pages.map((p) => <span key={p.id} className="tag">{p.title}</span>)}
        </div>
      </section>
      <section>
        <h4>交互预览</h4>
        <iframe
          className="proto-frame"
          srcDoc={prototype.html}
          title="产品原型预览"
          sandbox="allow-scripts allow-same-origin allow-modals"
        />
      </section>
      <section>
        <h4>核心流程 ({prototype.flows.length})</h4>
        {prototype.flows.map((f) => (
          <div key={f.name} className="flow-item">
            <b>{f.name}</b><span className="flow-desc">{f.description}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
