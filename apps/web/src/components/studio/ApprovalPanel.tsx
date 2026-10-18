'use client';

import { useEffect, useState } from 'react';

import type { ApprovalView } from '@apploom/shared';

export type { ApprovalView };

const RISK_LABEL: Record<ApprovalView['risk'], string> = { low: '低风险', medium: '中风险', high: '高风险' };

function remainingSeconds(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
}

function formatRemaining(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

/** 等待人工审批的高风险操作。流水线在此处挂起，超时未决策视为拒绝。 */
export function ApprovalPanel({
  approvals,
  onDecide,
}: {
  approvals: ApprovalView[];
  onDecide: (approval: ApprovalView, decision: 'approve' | 'reject') => Promise<void>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (approvals.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [approvals.length]);

  if (approvals.length === 0) return null;

  async function decide(a: ApprovalView, decision: 'approve' | 'reject') {
    setPendingIds((prev) => new Set(prev).add(a.id));
    try {
      await onDecide(a, decision);
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(a.id);
        return next;
      });
    }
  }

  return (
    <section className="approval-panel" role="alertdialog" aria-label="需要人工审批" data-testid="approval-panel">
      <div className="approval-title">⚠ 流水线已暂停，等待你审批（{approvals.length}）</div>
      {approvals.map((a) => {
        const left = remainingSeconds(a.expiresAt, now);
        const busy = pendingIds.has(a.id);
        return (
          <div key={a.id} className="approval-item" data-testid="approval-item">
            <div className="approval-head">
              <span className={`approval-risk approval-risk-${a.risk}`}>{RISK_LABEL[a.risk]}</span>
              <span className="approval-tool">{a.tool}</span>
              <span className="approval-timer" title="超时未决策将视为拒绝">
                {left > 0 ? `${formatRemaining(left)} 后自动拒绝` : '即将自动拒绝'}
              </span>
            </div>
            <div className="approval-summary">{a.summary}</div>
            <div className="approval-actions">
              <button className="approval-btn approval-reject" disabled={busy} onClick={() => decide(a, 'reject')}>
                拒绝
              </button>
              <button className="approval-btn approval-approve" disabled={busy} onClick={() => decide(a, 'approve')}>
                {busy ? '提交中…' : '批准执行'}
              </button>
            </div>
          </div>
        );
      })}
      <style>{`
        .approval-panel { position:sticky; top:0; z-index:50; margin:0; padding:12px 16px; background:#fff7ed; border-bottom:2px solid #f97316; box-shadow:0 2px 8px rgba(0,0,0,.08); }
        .approval-title { font-size:13px; font-weight:700; color:#9a3412; margin-bottom:8px; }
        .approval-item { background:#fff; border:1px solid #fdba74; border-radius:8px; padding:10px 12px; margin-top:8px; }
        .approval-head { display:flex; align-items:center; gap:8px; font-size:12px; margin-bottom:6px; }
        .approval-risk { padding:1px 8px; border-radius:999px; font-weight:600; color:#fff; }
        .approval-risk-high { background:#dc2626; }
        .approval-risk-medium { background:#f59e0b; }
        .approval-risk-low { background:#10b981; }
        .approval-tool { font-family:ui-monospace,Menlo,monospace; color:#6b7280; }
        .approval-timer { margin-left:auto; color:#9a3412; font-variant-numeric:tabular-nums; }
        .approval-summary { font-size:13px; line-height:1.5; color:#1f2937; word-break:break-all; }
        .approval-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:10px; }
        .approval-btn { border:1px solid transparent; border-radius:6px; padding:5px 14px; font-size:12px; font-weight:600; cursor:pointer; }
        .approval-btn:disabled { opacity:.6; cursor:not-allowed; }
        .approval-reject { background:#fff; border-color:#d1d5db; color:#374151; }
        .approval-approve { background:#ea580c; color:#fff; }
      `}</style>
    </section>
  );
}
