'use client';

import { useEffect, useState } from 'react';
import { errorClassMeta } from './errorClass';

import type { AttemptBrief, AttemptRecord, LlmLogEntry, LlmUsage, TraceData } from '@apploom/shared';

export type { AttemptBrief, TraceData };
type TraceUsage = LlmUsage;
/** 明细表只用调用日志里的这几个字段 */
type CallDetail = Omit<LlmLogEntry, 'user' | 'response' | 'ts'>;

const TRIGGER_LABEL: Record<AttemptBrief['trigger'], string> = {
  initial: '首次',
  retry: '重试',
  repair: '按反馈修改',
  'auto-repair': '自动修复',
};

const fmt = (n: number) => n.toLocaleString('en-US');
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const tokensOf = (u: TraceUsage) => u.promptTokens + u.completionTokens;

/**
 * 拉取整条流水线的执行记录与用量。refreshKey 变化（阶段状态变了）时重拉；
 * live=true 时每 4 秒兜底刷新一次（阶段内的自动修复轮不会触发状态变化）。
 */
export function useTrace(docId: string | undefined, refreshKey: string, live: boolean): TraceData | null {
  const [trace, setTrace] = useState<TraceData | null>(null);

  useEffect(() => {
    setTrace(null);
  }, [docId]);

  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/pipeline/${docId}/trace`);
        if (!res.ok || cancelled) return;
        setTrace((await res.json()) as TraceData);
      } catch { /* 静默：下次刷新再取 */ }
    };
    void load();
    if (!live) return () => { cancelled = true; };
    const t = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [docId, refreshKey, live]);

  return trace;
}

/** 整条流水线的 token 用量与预算占比 */
export function TraceSummary({ trace }: { trace: TraceData | null }) {
  if (!trace || trace.items.length === 0) return null;
  const { usage, budget, items } = trace;
  const ratio = budget > 0 ? usage.totalTokens / budget : 0;
  const level = ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'mid' : 'low';
  const failed = items.filter((a) => a.outcome === 'failed').length;
  const calls = items.reduce((s, a) => s + a.llmCalls, 0);
  const duration = items.reduce((s, a) => s + a.durationMs, 0);

  return (
    <section className="trace-summary" data-testid="trace-summary" aria-label="用量与预算">
      <div className="trace-summary-row">
        <span className="trace-summary-title">📊 Token 用量</span>
        <b data-testid="trace-total">{fmt(usage.totalTokens)}</b>
        <span className="trace-muted">/ {fmt(budget)}（{(ratio * 100).toFixed(1)}%）</span>
        {usage.estimated && <span className="trace-tag" title="部分调用服务端没返回 usage，按字符数估算">含估算</span>}
        <span className="trace-summary-meta">
          输入 {fmt(usage.promptTokens)} · 输出 {fmt(usage.completionTokens)} · {items.length} 次执行
          {failed > 0 && <span className="trace-fail"> （{failed} 次失败）</span>} · {calls} 次模型调用 · 累计 {seconds(duration)}
        </span>
      </div>
      <div className="trace-bar" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`trace-bar-fill trace-bar-${level}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      {ratio >= 0.9 && <div className="trace-warn">已接近预算上限，超出后会终止流水线（可调高 PIPELINE_TOKEN_BUDGET）</div>}
      <TraceStyles />
    </section>
  );
}

/** 单个阶段的执行记录；点开某次执行可看每次模型调用的用量 / 结束原因 / 耗时 */
export function StageAttempts({ docId, attempts }: { docId: string; attempts: AttemptBrief[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="trace-attempts" data-testid="stage-attempts">
      {attempts.map((a) => {
        const meta = a.outcome === 'failed' ? errorClassMeta(a.errorClass) : null;
        const open = openId === a.id;
        return (
          <div key={a.id} className={`trace-attempt trace-attempt-${a.outcome}`} data-testid="attempt-row">
            <button className="trace-attempt-head" onClick={() => setOpenId(open ? null : a.id)} aria-expanded={open}>
              <span className="trace-n">#{a.n}</span>
              <span className="trace-trigger">{TRIGGER_LABEL[a.trigger]}</span>
              <span className={`trace-outcome trace-outcome-${a.outcome}`}>{a.outcome === 'done' ? '成功' : '失败'}</span>
              {meta && <span className="trace-class" title={meta.hint}>{meta.label}</span>}
              <span className="trace-attempt-meta">
                {fmt(tokensOf(a.usage))} token{a.usage.estimated ? '(估)' : ''} · {a.llmCalls} 次调用 · {seconds(a.durationMs)}
              </span>
              <span className="trace-caret">{open ? '▾' : '▸'}</span>
            </button>
            {open && <AttemptDetail docId={docId} attempt={a} />}
          </div>
        );
      })}
      <TraceStyles />
    </div>
  );
}

function AttemptDetail({ docId, attempt }: { docId: string; attempt: AttemptBrief }) {
  const [calls, setCalls] = useState<CallDetail[] | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/pipeline/${docId}/trace/${attempt.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rec = (await res.json()) as Pick<AttemptRecord, 'llmLogs'>;
        if (!cancelled) setCalls(rec.llmLogs ?? []);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [docId, attempt.id]);

  return (
    <div className="trace-detail">
      <div className="trace-detail-line">开始于 {new Date(attempt.startedAt).toLocaleTimeString()} · 输入 {fmt(attempt.usage.promptTokens)} / 输出 {fmt(attempt.usage.completionTokens)} token</div>
      {attempt.feedback && (
        <div className="trace-detail-block">
          <div className="trace-detail-label">带入的反馈</div>
          <pre className="trace-pre">{attempt.feedback}</pre>
        </div>
      )}
      {attempt.error && (
        <div className="trace-detail-block">
          <div className="trace-detail-label">失败原因</div>
          <pre className="trace-pre trace-pre-error">{attempt.error}</pre>
        </div>
      )}
      <div className="trace-detail-label">模型调用</div>
      {loadError && <div className="trace-fail">明细加载失败：{loadError}</div>}
      {!calls && !loadError && <div className="trace-muted">加载中…</div>}
      {calls && calls.length === 0 && <div className="trace-muted">本次执行没有模型调用</div>}
      {calls && calls.length > 0 && (
        <table className="trace-calls">
          <thead>
            <tr><th>调用</th><th>模型</th><th>输入</th><th>输出</th><th>结束原因</th><th>耗时</th><th>备注</th></tr>
          </thead>
          <tbody>
            {calls.map((c, i) => (
              <tr key={i} className={c.error ? 'trace-call-error' : undefined}>
                <td>{c.label}{c.attempt ? `（网关重试 ${c.attempt}）` : ''}</td>
                <td>{c.model ?? '-'}</td>
                <td>{c.usage ? fmt(c.usage.promptTokens) : '-'}</td>
                <td>{c.usage ? fmt(c.usage.completionTokens) : '-'}{c.usage?.estimated ? '(估)' : ''}</td>
                <td className={c.finishReason === 'length' ? 'trace-fail' : undefined}>{c.finishReason === 'length' ? 'length（被截断）' : c.finishReason ?? '-'}</td>
                <td>{c.durationMs !== undefined ? seconds(c.durationMs) : '-'}</td>
                <td>{c.error ? `${c.errorClass ?? ''} ${c.error}`.trim().slice(0, 80) : c.fallbackReason ? '已切换备用模型' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TraceStyles() {
  return (
    <style>{`
      .trace-summary { margin:10px 0; padding:10px 14px; border:1px solid #e5e7eb; border-radius:10px; background:#fff; }
      .trace-summary-row { display:flex; align-items:baseline; flex-wrap:wrap; gap:8px; font-size:13px; }
      .trace-summary-title { font-weight:700; color:#374151; }
      .trace-summary-row b { font-size:16px; font-variant-numeric:tabular-nums; }
      .trace-summary-meta { margin-left:auto; color:#6b7280; font-size:12px; }
      .trace-muted { color:#6b7280; }
      .trace-tag { font-size:11px; padding:0 6px; border-radius:999px; background:#fef3c7; color:#92400e; }
      .trace-fail { color:#dc2626; }
      .trace-bar { height:6px; border-radius:999px; background:#f3f4f6; margin-top:8px; overflow:hidden; }
      .trace-bar-fill { height:100%; border-radius:999px; transition:width .3s; }
      .trace-bar-low { background:#10b981; }
      .trace-bar-mid { background:#f59e0b; }
      .trace-bar-high { background:#dc2626; }
      .trace-warn { margin-top:6px; font-size:12px; color:#b45309; }
      .trace-attempts { margin:8px 0; border:1px solid #e5e7eb; border-radius:8px; background:#fafafa; }
      .trace-attempt + .trace-attempt { border-top:1px solid #e5e7eb; }
      .trace-attempt-head { display:flex; align-items:center; gap:8px; width:100%; padding:7px 10px; border:0; background:transparent; font-size:12px; text-align:left; cursor:pointer; }
      .trace-attempt-head:hover { background:#f3f4f6; }
      .trace-n { font-weight:700; font-variant-numeric:tabular-nums; }
      .trace-trigger { color:#4b5563; }
      .trace-outcome { padding:0 7px; border-radius:999px; font-weight:600; color:#fff; }
      .trace-outcome-done { background:#10b981; }
      .trace-outcome-failed { background:#dc2626; }
      .trace-class { padding:0 7px; border-radius:999px; background:#fee2e2; color:#991b1b; }
      .trace-attempt-meta { margin-left:auto; color:#6b7280; font-variant-numeric:tabular-nums; }
      .trace-caret { color:#9ca3af; }
      .trace-detail { padding:8px 12px 12px; font-size:12px; border-top:1px dashed #e5e7eb; background:#fff; }
      .trace-detail-line { color:#6b7280; margin-bottom:6px; }
      .trace-detail-label { margin:8px 0 4px; font-weight:600; color:#374151; }
      .trace-pre { margin:0; padding:6px 8px; max-height:160px; overflow:auto; white-space:pre-wrap; word-break:break-all; background:#f9fafb; border-radius:6px; font-family:ui-monospace,Menlo,monospace; }
      .trace-pre-error { background:#fef2f2; color:#991b1b; }
      .trace-calls { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
      .trace-calls th, .trace-calls td { padding:3px 6px; text-align:left; border-bottom:1px solid #f3f4f6; }
      .trace-calls th { color:#6b7280; font-weight:600; }
      .trace-call-error td { color:#991b1b; }
    `}</style>
  );
}
