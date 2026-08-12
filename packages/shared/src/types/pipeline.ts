/**
 * Pipeline 流水线核心类型
 * 这是 AI 研发平台的"心脏"——描述 AI Pipeline 各环节的产物与流转
 */

/** Pipeline 阶段（4 + 1：安全审查贯穿） */
export type PipelineStage = 'REQUIREMENT' | 'DESIGN' | 'CODEGEN' | 'SECURITY' | 'DEPLOY';

/** 阶段执行状态 */
export type StageStatus = 'PENDING' | 'RUNNING' | 'WAITING_CONFIRM' | 'COMPLETED' | 'FAILED';

/** 流水线运行模式 */
export type PipelineMode = 'AUTO' | 'STEP_BY_STEP';

/** 全局共享上下文：Agent 之间通过它传递数据 */
export interface PipelineContext {
  projectId: string;
  userInput: string;
  currentStage: PipelineStage;
  stageStatus: Record<PipelineStage, StageStatus>;
  /** 各阶段的产出物 */
  outputs: Partial<Record<PipelineStage, unknown>>;
  /** 运行模式：全自动 / 逐步确认 */
  mode: PipelineMode;
}

/** Agent 执行结果 */
export interface AgentResult {
  success: boolean;
  output: unknown;
  error?: string;
}

/** 需求分析 Agent 产出：结构化 PRD */
export interface PRDDocument {
  productName: string;
  productOverview: string;
  targetUsers: string[];
  coreValue: string;
  features: Array<{
    id: string;
    name: string;
    priority: 'P0' | 'P1' | 'P2';
    description: string;
  }>;
  pages: string[];
  dataEntities: Array<{
    name: string;
    fields: Array<{ name: string; type: string; description: string }>;
  }>;
}

/** 架构设计 Agent 产出：技术方案 */
export interface DesignDocument {
  techStack: string[];
  architecture: string;
  pageTree: Array<{ path: string; component: string; description: string }>;
  dataModels: Array<{ name: string; fields: Array<{ name: string; type: string }> }>;
  apis: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; description: string }>;
}

/** 代码生成 Agent 产出：文件集合 */
export interface CodeFile {
  path: string;
  content: string;
}

export interface CodegenOutput {
  files: CodeFile[];
  entryPoint?: string;
}

/** 部署 Agent 产出 */
export interface DeployOutput {
  url: string;
  deployDir: string;
  status: 'DEPLOYING' | 'RUNNING' | 'FAILED';
}
