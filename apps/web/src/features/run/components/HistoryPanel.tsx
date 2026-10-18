import { STAGE_LABEL, STAGE_IDS } from '@apploom/shared/graph';
import type { PipelineDocSummary } from '@apploom/shared';
import { pipelineBadge, pipelineStatusLabel, statusLabel, toStatus } from '../status';

const STAGES = [...STAGE_IDS];

/** 历史项目面板 */
export function HistoryPanel({ history, onClose, onOpen }: { history: PipelineDocSummary[]; onClose: () => void; onOpen: (id: string) => void }) {
  return (
    <div className="history-overlay" onClick={() => onClose()}>
      <div className="history-panel" onClick={(e) => e.stopPropagation()}>
        <div className="history-head">
          <span>📚 历史项目（{history.length}）</span>
          <button className="btn btn-ghost" onClick={() => onClose()}>关闭</button>
        </div>
        <div className="history-list">
          {history.length === 0 && <p className="ph">还没有历史项目</p>}
          {history.map((h) => (
            <div key={h.id} className="history-item" onClick={() => onOpen(h.id)}>
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
  );
}
