/**
 * TraceStore —— 阶段执行记录（Attempt）存储的抽象（Nest DI token）：只追加、每条流水线只保留最近 MAX_ATTEMPTS 条。
 * 与主文档分开存放：完整 prompt / 响应体积大，放进主文档会让每次状态更新都重写整份 JSON。
 * 实现：Redis（trace.redis-store.ts）与 Postgres（trace.pg-store.ts）。
 */
import type { AttemptRecord, LlmLogEntry, LlmUsage, PipelineStage } from '../pipeline/pipeline.types';

export const MAX_ATTEMPTS = 60;

/** 汇总一次执行内所有 LLM 调用的用量；任一条为估算值则整体标 estimated */
export function summarizeUsage(logs: LlmLogEntry[]): LlmUsage {
  const total: LlmUsage = { promptTokens: 0, completionTokens: 0 };
  for (const l of logs) {
    total.promptTokens += l.usage?.promptTokens ?? 0;
    total.completionTokens += l.usage?.completionTokens ?? 0;
    if (l.usage?.estimated) total.estimated = true;
  }
  return total;
}

export abstract class TraceStore {
  /** 追加一条记录；trace 写失败只告警，绝不影响流水线主流程 */
  abstract append(record: AttemptRecord): Promise<void>;
  abstract list(docId: string, stage?: PipelineStage): Promise<AttemptRecord[]>;
  abstract get(docId: string, attemptId: string): Promise<AttemptRecord | null>;
  abstract remove(docId: string): Promise<void>;
}
