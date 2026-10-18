/**
 * Pipeline 异步流水线 —— 类型定义
 *
 * W7 Agent 工程化：把多个 Agent 从「前端点一下下一步」改为后台异步任务，
 * 支持实时进度（SSE）、逐步确认、失败重试。
 *
 * 状态机：
 *   Pipeline: created → running → (waiting_confirm ⇄ running) → completed | failed
 *   Stage:    pending → running → done | failed | waiting_confirm
 */

import { STAGE_IDS, STAGE_LABEL, type StageId } from '@apploom/shared';
import type { PipelineDoc, StageState } from '@apploom/shared';

// 这些数据传输类型在前后端共用，定义在 @apploom/shared 的 dto.ts——不要在这里重新定义，只管重新导出
export type {
  ApprovalView,
  AttemptBrief,
  AttemptRecord,
  AttemptTrigger,
  ErrorClass,
  LlmLogEntry,
  LlmUsage,
  PipelineDoc,
  PipelineDocSummary,
  PipelineEvent,
  PipelineStatus,
  StageState,
  StageStatus,
  TraceData,
} from '@apploom/shared';

/** 流水线阶段（Agent 顺序）——由 @apploom/shared 的 STAGE_GRAPH 推导，不要在这里手写 */
export type PipelineStage = StageId;

/** 构建初始 stage state */
export function emptyStage(): StageState {
  return { status: 'pending', attempts: 0 };
}

/** 构建新流水线文档 */
export function createPipelineDoc(requirement: string, confirmEachStep: boolean): PipelineDoc {
  const now = new Date().toISOString();
  return {
    id: '',
    version: 0,
    requirement,
    status: 'created',
    confirmEachStep,
    currentStage: null,
    stages: Object.fromEntries(PIPELINE_STAGES.map((st) => [st, emptyStage()])) as PipelineDoc['stages'],
    handoffs: Object.fromEntries(PIPELINE_STAGES.map((st) => [st, false])) as PipelineDoc['handoffs'],
    createdAt: now,
    updatedAt: now,
  };
}

export const PIPELINE_STAGES: PipelineStage[] = [...STAGE_IDS];

/** 阶段中文名：来自 STAGE_GRAPH，与前端共用同一份 */
export { STAGE_LABEL };
