/**
 * 前后端共用的数据传输类型（HTTP / SSE 上跑的 JSON 形状）。纯类型，没有运行时代码，前端 `import type` 不会带入任何东西。
 *
 * 这里是这些类型的唯一定义：后端的存储 / 控制器 / 事件总线、前端的 Studio / 面板都从这里引用，
 * 不要再在别处手抄一份——手抄必然漂移（前端的 Deploy 类型就曾因此缺了后端新增的 port 字段）。
 * 阶段 id 与展示名来自 STAGE_GRAPH（graph.ts）。
 */
import type { StageId } from './graph';

// ───────────────────────── 错误类别（决定恢复策略，详见 llm 包 errors.ts） ─────────────────────────

/**
 *  transient      超时 / 429 / 5xx / 网络错误        → 指数退避重试
 *  invalid_input  请求参数不合法（4xx）              → 不重试
 *  invalid_output 模型输出不符合契约（JSON/Zod 失败） → 不盲目重试，把校验错误回喂模型
 *  truncated      输出被 max_tokens 截断             → 放大上限 + 要求精简后重生成
 *  permission     鉴权失败 / 权限不足（401/403）      → 不重试，需要人处理
 *  not_found      模型或资源不存在（404）            → 不重试
 *  budget         超出预算 / 服务商额度用完（402）    → 终止，需人处理
 *  verification   确定性门禁未通过（如 codegen 门禁） → 已内部修复过，不再重试
 *  execution      本地执行失败（如部署 install）      → 不自动重试，交给人
 *  unknown        其它                               → 记录并终止
 */
export type ErrorClass =
  | 'transient'
  | 'invalid_input'
  | 'invalid_output'
  | 'truncated'
  | 'permission'
  | 'not_found'
  | 'budget'
  | 'verification'
  | 'execution'
  | 'unknown';

// ───────────────────────── 模型调用 ─────────────────────────

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** true = 服务端没返回 usage，按字符数粗略估算 */
  estimated?: boolean;
}

/** 单次 LLM 调用日志（供前端调试入口展示，同时是 trace 的最小单元） */
export interface LlmLogEntry {
  label: string;
  ts: string;
  /** user prompt（含 repair 反馈，是调试关键） */
  user: string;
  /** 模型响应原文（失败时为已收到的部分内容） */
  response: string;
  model?: string;
  temperature?: number;
  durationMs?: number;
  usage?: LlmUsage;
  /** 模型停止原因；'length' 表示被 max_tokens 截断 */
  finishReason?: string;
  /** 第几次尝试（0 = 首次，>0 = 网关自动重试） */
  attempt?: number;
  /** 本次调用失败时的错误类别与信息 */
  errorClass?: ErrorClass;
  error?: string;
  /** 本次调用由备用模型完成时，记录切换原因 */
  fallbackReason?: string;
}

// ───────────────────────── 流水线文档 ─────────────────────────

/** 流水线整体状态 */
export type PipelineStatus =
  | 'created' // 任务已创建，还没开始跑
  | 'running' // 某个阶段正在执行
  | 'waiting_confirm' // 阶段已完成，等待用户确认继续（逐步确认模式）
  | 'failed' // 某个阶段失败，可重试
  | 'completed'; // 全部阶段完成

/** 单个阶段状态 */
export type StageStatus =
  | 'pending' // 还没轮到
  | 'running' // 正在执行
  | 'done' // 完成，产出已保存
  | 'failed' // 失败，可重试
  | 'waiting_confirm' // 等待确认后继续下一步
  | 'stale'; // 产物还在，但它基于的上游已经变了（STAGE_STALE_CASCADE 开启时才会出现）

/** 单个阶段的执行结果 */
export interface StageState {
  status: StageStatus;
  /** 结构化产出（PRD / Prototype / Design / Codegen / Deploy） */
  result?: unknown;
  /** 当前产出的内容指纹（稳定序列化 + SHA-256 前 16 位）；产出成功时写入 */
  fingerprint?: string;
  /** 产出时所依据的上游指纹：键是 STAGE_GRAPH 入边的 from（上游阶段 id；首阶段为 '@input'），值是当时那份上游的指纹。
   *  用来回答「这份产物基于哪一版上游」，也是判断它是否已过期的依据 */
  consumed?: Record<string, string>;
  /** LLM 原始输出（调试用） */
  raw?: string;
  /** 摘要（供前端卡片展示，如功能数 / 文件数） */
  summary?: unknown;
  /** 失败信息 */
  error?: string;
  /** 失败的错误类别（决定恢复策略） */
  errorClass?: ErrorClass;
  /** 已尝试次数（重试会 +1） */
  attempts: number;
  /** 用户填的修复/修改意见（带反馈重生成） */
  feedback?: string;
  /** 历史产出（供 LLM 参考「上次产出 + 反馈」） */
  history?: Array<{ result?: unknown; error?: string }>;
  /** 本阶段 LLM 调用日志（调试入口展示） */
  llmLogs?: LlmLogEntry[];
  startedAt?: string;
  finishedAt?: string;
}

/** 流水线文档 —— 存 Redis，是任务状态的唯一事实来源 */
export interface PipelineDoc {
  id: string;
  /** 创建者（API Key 名）；未启用认证或升级前的老数据没有此字段，视为公共 */
  ownerId?: string;
  /** 乐观锁版本：每次成功写入 +1（由存储层维护，业务代码不要手改） */
  version: number;
  requirement: string;
  status: PipelineStatus;
  /** 逐步确认模式：每个阶段完成后暂停等待确认（最后阶段除外） */
  confirmEachStep: boolean;
  /** 当前正在执行（或刚完成等待确认）的阶段 */
  currentStage: StageId | null;
  stages: Record<StageId, StageState>;
  /** 各阶段「是否已完成交接」（入队下一阶段 / 挂起等待 / 完成流水线）。
   *  用于 job 重复执行时幂等跳过，避免崩溃重启后链式重复入队。 */
  handoffs: Record<StageId, boolean>;
  createdAt: string;
  updatedAt: string;
}

/** 历史项目列表摘要（不含大字段 result/raw/history） */
export interface PipelineDocSummary {
  id: string;
  ownerId?: string;
  requirement: string;
  status: PipelineStatus;
  currentStage: StageId | null;
  createdAt: string;
  updatedAt: string;
  /** 各阶段状态快照 */
  stages: Record<StageId, StageStatus>;
}

// ───────────────────────── 执行记录（trace） ─────────────────────────

/** 触发一次阶段执行的原因 */
export type AttemptTrigger = 'initial' | 'retry' | 'repair' | 'auto-repair';

/**
 * 一次阶段执行（Attempt）的完整记录 —— 存独立 Redis list，不撑大主文档。
 * 保留完整 prompt / 响应，使任意一次执行可事后复盘与重放。
 */
export interface AttemptRecord {
  id: string;
  docId: string;
  stage: StageId;
  /** 该阶段的第几次执行（含自动修复轮） */
  n: number;
  trigger: AttemptTrigger;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: 'done' | 'failed';
  errorClass?: ErrorClass;
  error?: string;
  /** 本次执行带入的用户/自动反馈 */
  feedback?: string;
  usage: LlmUsage;
  llmCalls: number;
  llmLogs: LlmLogEntry[];
}

/** 列表接口返回的执行记录：不含体积大的 llmLogs（点开某次执行时再取完整记录） */
export type AttemptBrief = Omit<AttemptRecord, 'llmLogs'>;

/** GET /pipeline/:id/trace 的响应 */
export interface TraceData {
  items: AttemptBrief[];
  usage: LlmUsage & { totalTokens: number };
  /** 单条流水线 token 预算（PIPELINE_TOKEN_BUDGET） */
  budget: number;
}

// ───────────────────────── 人工审批 ─────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high';

/** 待人工审批的高风险操作（供 SSE / REST 展示） */
export interface ApprovalView {
  id: string;
  docId: string;
  stage: StageId;
  tool: string;
  /** 人类可读的操作摘要 */
  summary: string;
  risk: RiskLevel;
  createdAt: string;
  /** 超过该时间未决策将视为拒绝 */
  expiresAt: string;
}

// ───────────────────────── SSE 事件 ─────────────────────────

/** worker → SSE 的事件（事件名与 type 一致，见 pipeline.controller.ts） */
export type PipelineEvent =
  | { type: 'snapshot'; doc: PipelineDoc }
  | { type: 'stage'; stage: StageId; status: StageStatus; summary?: unknown; result?: unknown; error?: string; errorClass?: ErrorClass }
  | { type: 'token'; stage: StageId; token: string }
  | { type: 'job'; status: PipelineStatus }
  | { type: 'done'; doc: PipelineDoc }
  | { type: 'error'; stage: StageId; message: string }
  | { type: 'approval'; approval: ApprovalView }
  | { type: 'approval-resolved'; id: string; decision: string };
