/**
 * Pipeline 异步流水线 —— 类型定义
 *
 * W7 Agent 工程化：把 4 个 Agent 从「前端点一下下一步」改为后台异步任务，
 * 支持实时进度（SSE）、逐步确认、失败重试。
 *
 * 状态机：
 *   Pipeline: created → running → (waiting_confirm ⇄ running) → completed | failed
 *   Stage:    pending → running → done | failed | waiting_confirm
 */

/** 4 个流水线阶段（Agent 顺序） */
export type PipelineStage = 'requirement' | 'design' | 'codegen' | 'deploy';

/** 流水线整体状态 */
export type PipelineStatus =
  | 'created'      // 任务已创建，还没开始跑
  | 'running'      // 某个阶段正在执行
  | 'waiting_confirm' // 阶段已完成，等待用户确认继续（逐步确认模式）
  | 'failed'       // 某个阶段失败，可重试
  | 'completed';   // 全部 4 阶段完成

/** 单个阶段状态 */
export type StageStatus =
  | 'pending'          // 还没轮到
  | 'running'          // 正在执行
  | 'done'             // 完成，产出已保存
  | 'failed'           // 失败，可重试
  | 'waiting_confirm'; // 等待确认后继续下一步

/** 单个阶段的执行结果 */
export interface StageState {
  status: StageStatus;
  /** 结构化产出（PRD / Design / Codegen / Deploy） */
  result?: unknown;
  /** LLM 原始输出（调试用） */
  raw?: string;
  /** 摘要（供前端卡片展示，如功能数 / 文件数） */
  summary?: unknown;
  /** 失败信息 */
  error?: string;
  /** 已尝试次数（重试会 +1） */
  attempts: number;
  /** 用户填的修复/修改意见（带反馈重生成） */
  feedback?: string;
  /** 历史产出（供 LLM 参考「上次产出 + 反馈」） */
  history?: Array<{ result?: unknown; error?: string }>;
  startedAt?: string;
  finishedAt?: string;
}

/** 流水线文档 —— 存 Redis，是任务状态的唯一事实来源 */
export interface PipelineDoc {
  id: string;
  requirement: string;
  status: PipelineStatus;
  /** 逐步确认模式：每个阶段完成后暂停等待确认（最后阶段除外） */
  confirmEachStep: boolean;
  /** 当前正在执行（或刚完成等待确认）的阶段 */
  currentStage: PipelineStage | null;
  stages: Record<PipelineStage, StageState>;
  /** 已确认过的阶段（防 worker 与 confirm 竞态：先确认后 worker 才挂起） */
  pendingConfirms: PipelineStage[];
  /** 各阶段「是否已完成交接」（入队下一阶段 / 挂起等待 / 完成流水线）。
   *  用于 job 重复执行时幂等跳过，避免崩溃重启后链式重复入队。 */
  handoffs: Record<PipelineStage, boolean>;
  createdAt: string;
  updatedAt: string;
}

/** 构建初始 stage state */
export function emptyStage(): StageState {
  return { status: 'pending', attempts: 0 };
}

/** 构建新流水线文档 */
export function createPipelineDoc(requirement: string, confirmEachStep: boolean): PipelineDoc {
  const now = new Date().toISOString();
  return {
    id: '',
    requirement,
    status: 'created',
    confirmEachStep,
    currentStage: null,
    stages: {
      requirement: emptyStage(),
      design: emptyStage(),
      codegen: emptyStage(),
      deploy: emptyStage(),
    },
    pendingConfirms: [],
    handoffs: {
      requirement: false,
      design: false,
      codegen: false,
      deploy: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** 事件类型（通过 EventEmitter 桥接 worker → SSE） */
export type PipelineEvent =
  | { type: 'snapshot'; doc: PipelineDoc }
  | { type: 'stage'; stage: PipelineStage; status: StageStatus; summary?: unknown; result?: unknown }
  | { type: 'token'; stage: PipelineStage; token: string }
  | { type: 'job'; status: PipelineStatus }
  | { type: 'done'; doc: PipelineDoc }
  | { type: 'error'; stage: PipelineStage; message: string };

/** 历史项目列表摘要（不含大字段 result/raw/history） */
export interface PipelineDocSummary {
  id: string;
  requirement: string;
  status: PipelineStatus;
  currentStage: PipelineStage | null;
  createdAt: string;
  updatedAt: string;
  /** 各阶段状态快照 */
  stages: Record<PipelineStage, StageStatus>;
}

export const PIPELINE_STAGES: PipelineStage[] = ['requirement', 'design', 'codegen', 'deploy'];

/** 阶段中文名（前端展示用） */
export const STAGE_LABEL: Record<PipelineStage, string> = {
  requirement: '需求拆解',
  design: '方案设计',
  codegen: '代码生成',
  deploy: '部署发布',
};
