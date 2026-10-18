'use client';

import { useEffect, useState } from 'react';
import { ApprovalPanel } from '@/components/studio/ApprovalPanel';
import { TraceSummary, useTrace } from '@/components/studio/TracePanel';
import { HistoryPanel } from '@/features/run/components/HistoryPanel';
import { InputCard } from '@/features/run/components/InputCard';
import { PreviewPane } from '@/features/run/components/PreviewPane';
import { StageCard, type StageUi } from '@/features/run/components/StageCard';
import { StatusBanner } from '@/features/run/components/StatusBanner';
import { toStatus } from '@/features/run/status';
import { STUDIO_CSS } from '@/features/run/studioStyles';
import { useRunMachine } from '@/features/run/useRunMachine';
import { STAGE_IDS, type StageId } from '@apploom/shared/graph';
import type { CodegenDocument, DeployDocument, DesignDocument, PipelineDocSummary, PRD, PrototypeDocument } from '@apploom/shared';

const STAGES: StageId[] = [...STAGE_IDS];

export default function StudioPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) {
    return <div style={{ padding: 40, color: '#9ca3af', fontSize: 13 }} suppressHydrationWarning>加载 Studio…</div>;
  }

  return <StudioPageInner />;
}

function StudioPageInner() {
  // 服务端派生的状态与所有和后端打交道的动作都在 useRunMachine；这里只留纯界面状态
  const { state, busy, start, confirmStage, retryStage, repairStage, disconnect, loadHistory, openDoc, decideApproval } = useRunMachine();
  const { doc, tokens, approvals, connected, error } = state;
  const [requirement, setRequirement] = useState('做一个团队待办事项应用，支持任务指派和看板');
  const [confirmMode, setConfirmMode] = useState(true);
  const [repairOpen, setRepairOpen] = useState<StageId | null>(null);
  const [repairText, setRepairText] = useState('');
  const [history, setHistory] = useState<PipelineDocSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [logOpen, setLogOpen] = useState<StageId | null>(null);
  const [traceOpen, setTraceOpen] = useState<StageId | null>(null);

  /** 提交修改：成功后收起输入框 */
  async function submitRepair(stage: StageId, feedback?: string) {
    if (await repairStage(stage, feedback)) {
      setRepairOpen(null);
      setRepairText('');
    }
  }

  /** 打开历史项目面板 */
  async function openHistoryPanel() {
    const items = await loadHistory();
    if (items) {
      setHistory(items);
      setShowHistory(true);
    }
  }

  /** 选中某个历史项目 */
  async function openHistory(id: string) {
    if (await openDoc(id)) setShowHistory(false);
  }

  // 阶段状态变化（含自动修复后的新 Attempt）即重拉执行记录；运行中再 4s 兜底刷新
  const traceKey = doc ? `${doc.status}|${STAGES.map((s) => `${s}:${doc.stages[s].status}:${doc.stages[s].attempts}`).join(',')}` : '';
  const trace = useTrace(doc?.id, traceKey, doc?.status === 'running');

  // ===== 派生状态 =====
  const isCompleted = doc?.status === 'completed';
  const isFailed = doc?.status === 'failed';
  const activeStage = doc?.currentStage ?? null;
  const activeRunning = activeStage !== null && toStatus(doc?.stages[activeStage]?.status) === 'running';
  const streaming = activeStage ? tokens[activeStage] : '';

  const prd = doc?.stages.requirement.result as PRD | undefined;
  const prototype = doc?.stages.prototype.result as PrototypeDocument | undefined;
  const design = doc?.stages.design.result as DesignDocument | undefined;
  const codegen = doc?.stages.codegen.result as CodegenDocument | undefined;
  const deploy = doc?.stages.deploy.result as DeployDocument | undefined;

  const canStart = !doc || isCompleted || isFailed;
  const previewLabel = deploy ? 'DeployDocument' : codegen ? 'CodegenDocument' : design ? 'DesignDocument' : prototype ? 'PrototypeDocument' : prd ? 'PRD' : '待生成';

  const ui: StageUi = { repairOpen, repairText, logOpen, traceOpen, setRepairOpen, setRepairText, setLogOpen, setTraceOpen };

  return (
    <div className="page">
      <header className="topbar">
        <span className="logo">🚀 AppLoom · Studio</span>
        <span className="sub">
          生产端 · 异步 5-Agent 流水线（BullMQ + SSE）
          {connected && <span style={{ color: '#10b981', marginLeft: 6 }}>● 实时连接</span>}
        </span>
        <button className="btn btn-ghost" onClick={openHistoryPanel}>📚 历史项目</button>
      </header>

      <ApprovalPanel approvals={approvals} onDecide={decideApproval} />

      {showHistory && <HistoryPanel history={history} onClose={() => setShowHistory(false)} onOpen={openHistory} />}

      {doc && (
        <StatusBanner doc={doc} activeStage={activeStage} streaming={streaming} busy={busy} disconnect={disconnect} confirmStage={confirmStage} retryStage={retryStage} />
      )}

      <div className="layout">
        {/* 左：输入 + 流水线 */}
        <main className="main">
          <InputCard
            doc={doc} requirement={requirement} setRequirement={setRequirement} confirmMode={confirmMode} setConfirmMode={setConfirmMode}
            canStart={canStart} start={() => start(requirement, confirmMode)} activeStage={activeStage} streaming={streaming}
          />

          <TraceSummary trace={trace} />

          <div className="pipeline">
            {STAGES.map((stage, i) => (
              <StageCard
                key={stage} stage={stage} i={i} doc={doc} attempts={trace?.items.filter((a) => a.stage === stage) ?? []}
                tokens={tokens} busy={busy} ui={ui} results={{ prd, prototype, design, codegen, deploy }}
                confirmStage={confirmStage} retryStage={retryStage} submitRepair={submitRepair}
              />
            ))}
          </div>

          {error && <div className="err">⚠ {error}</div>}
        </main>

        {/* 右：产出预览 */}
        <PreviewPane
          showStream={activeRunning} streaming={streaming} previewLabel={previewLabel}
          deploy={deploy} codegen={codegen} design={design} prototype={prototype} prd={prd}
        />
      </div>

      <style>{STUDIO_CSS}</style>
    </div>
  );
}
