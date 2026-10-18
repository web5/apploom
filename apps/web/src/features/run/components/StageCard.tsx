import { STAGE_IDS, STAGE_LABEL, type StageId } from '@apploom/shared/graph';
import type { AttemptBrief, CodegenDocument, DeployDocument, DesignDocument, PipelineDoc, PRD, PrototypeDocument } from '@apploom/shared';
import { errorClassMeta } from '@/components/studio/errorClass';
import { StageAttempts } from '@/components/studio/TracePanel';
import { statusIcon, statusLabel, toStatus } from '../status';
import { LlmLogPanel } from './LlmLogPanel';
import { StageLoading } from './StageLoading';
import { stageMeta } from './stageMeta';

/** 同一时刻只展开一个的界面状态（由页面持有：展开修改框的阶段、展开日志 / 执行记录的阶段） */
export interface StageUi {
  repairOpen: StageId | null;
  repairText: string;
  logOpen: StageId | null;
  traceOpen: StageId | null;
  setRepairOpen: (s: StageId | null) => void;
  setRepairText: (t: string) => void;
  setLogOpen: (s: StageId | null) => void;
  setTraceOpen: (s: StageId | null) => void;
}

export interface StageResults {
  prd?: PRD;
  prototype?: PrototypeDocument;
  design?: DesignDocument;
  codegen?: CodegenDocument;
  deploy?: DeployDocument;
}

/** 流水线里的一个阶段卡片：头部、状态相关的操作框、摘要行，以及下方可展开的执行记录与连接线 */
export function StageCard({
  stage, i, doc, attempts, tokens, busy, ui, results, confirmStage, retryStage, submitRepair,
}: {
  stage: StageId;
  /** 在流水线里的序号（从 0 起），用于编号圆圈和决定是否画连接线 */
  i: number;
  doc: PipelineDoc | null;
  attempts: AttemptBrief[];
  tokens: Record<StageId, string>;
  busy: Record<StageId, boolean>;
  ui: StageUi;
  results: StageResults;
  confirmStage: (stage: StageId) => void;
  retryStage: (stage?: StageId) => void;
  submitRepair: (stage: StageId, feedback?: string) => void;
}) {
  const { repairOpen, repairText, logOpen, traceOpen, setRepairOpen, setRepairText, setLogOpen, setTraceOpen } = ui;
  const { prd, prototype, design, codegen, deploy } = results;
  const st = toStatus(doc?.stages[stage]?.status);
  const stageState = doc?.stages[stage];

  /** 对话式修改输入框（done / waiting_confirm / error 状态通用） */
  const repairEntry = (stage: StageId) => (
    <div className="repair-box">
      <textarea
        className="ta repair-ta"
        placeholder={`用一句话告诉 AI 怎么改「${STAGE_LABEL[stage]}」，例如：改成深色主题 / 去掉 XX 功能 / 修复报错：xxx。留空则直接重新生成`}
        value={repairText}
        onChange={(e) => setRepairText(e.target.value)}
        autoFocus
      />
      <div className="row">
        <button className="btn btn-primary" onClick={() => submitRepair(stage, repairText)} disabled={busy[stage]}>
          {busy[stage] ? '提交中…' : (repairText.trim() ? '提交修改' : '直接重新生成')}
        </button>
        <button className="btn btn-ghost" onClick={() => { setRepairOpen(null); setRepairText(''); }}>取消</button>
      </div>
    </div>
  );

  return (
    <div key={stage}>
      <div className={`stage stage-${st}`}>
        <div className="stage-head">
          <span className="stage-num">{statusIcon(st, i + 1)}</span>
          <span className="stage-title">{STAGE_LABEL[stage]}</span>
          <span className={`badge badge-${st}`}>{statusLabel(st)}</span>
          {attempts.length > 0 && (
            <button className="btn btn-log" data-testid="trace-toggle" onClick={() => setTraceOpen(traceOpen === stage ? null : stage)}>
              📊 {attempts.length} 次执行
            </button>
          )}
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
        {st === 'stale' && (
          <div className="stage-body">
            <div className="confirm-box">
              <span>↻ 上游已变更，以下是旧版本产物；轮到本阶段时会先比对它依据的上游，没变则沿用，变了才重新生成</span>
            </div>
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
      {traceOpen === stage && doc && attempts.length > 0 && <StageAttempts docId={doc.id} attempts={attempts} />}
      {i < STAGE_IDS.length - 1 && <div className="connector" />}
    </div>
  );
}
