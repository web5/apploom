import { STAGE_IDS, STAGE_LABEL, type StageId } from '@apploom/shared/graph';
import type { PipelineDoc } from '@apploom/shared';

const STAGES = [...STAGE_IDS];

/** 全宽状态 Banner */
export function StatusBanner({
  doc, activeStage, streaming, busy, disconnect, confirmStage, retryStage,
}: {
  doc: PipelineDoc;
  activeStage: StageId | null;
  streaming: string;
  busy: Record<StageId, boolean>;
  disconnect: () => void;
  confirmStage: (stage: StageId) => void;
  retryStage: (stage?: StageId) => void;
}) {
  const isRunning = doc.status === 'running';
  const isWaiting = doc.status === 'waiting_confirm';
  const isFailed = doc.status === 'failed';
  const isCompleted = doc.status === 'completed';
  return (
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
  );
}
