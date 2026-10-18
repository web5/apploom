import { STAGE_LABEL, type StageId } from '@apploom/shared/graph';
import type { PipelineDoc } from '@apploom/shared';

/** 一句话需求输入 + 开始按钮 + 运行 / 等待提示 */
export function InputCard({
  doc, requirement, setRequirement, confirmMode, setConfirmMode, canStart, start, activeStage, streaming,
}: {
  doc: PipelineDoc | null;
  requirement: string;
  setRequirement: (v: string) => void;
  confirmMode: boolean;
  setConfirmMode: (v: boolean) => void;
  canStart: boolean;
  start: () => void;
  activeStage: StageId | null;
  streaming: string;
}) {
  const isRunning = doc?.status === 'running';
  const isWaiting = doc?.status === 'waiting_confirm';
  const isCompleted = doc?.status === 'completed';
  return (
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
  );
}
