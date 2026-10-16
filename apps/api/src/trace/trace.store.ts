/**
 * TraceStore —— 阶段执行记录（Attempt）的追加式存储
 *
 * 一个流水线一个 Redis list：`pipeline:trace:{docId}`，只追加、只保留最近 MAX_ATTEMPTS 条。
 * 与主文档分开存放：完整 prompt / 响应体积大，放进主文档会让每次状态更新都重写整份 JSON。
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { AttemptRecord, LlmLogEntry, LlmUsage, PipelineStage } from '../pipeline/pipeline.types';

const TRACE_KEY_PREFIX = 'pipeline:trace:';
const MAX_ATTEMPTS = 60;

export function traceKey(docId: string): string {
  return `${TRACE_KEY_PREFIX}${docId}`;
}

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

@Injectable()
export class TraceStore implements OnModuleDestroy {
  private readonly logger = new Logger(TraceStore.name);
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
    });
    this.redis.on('error', (e) => this.logger.warn(`Redis 连接错误: ${e.message}`));
  }

  /** 追加一条记录；trace 写失败只告警，绝不影响流水线主流程 */
  async append(record: AttemptRecord): Promise<void> {
    try {
      const key = traceKey(record.docId);
      await this.redis.multi().rpush(key, JSON.stringify(record)).ltrim(key, -MAX_ATTEMPTS, -1).exec();
    } catch (e) {
      this.logger.warn(`trace 写入失败 doc=${record.docId} stage=${record.stage}: ${(e as Error).message}`);
    }
  }

  async list(docId: string, stage?: PipelineStage): Promise<AttemptRecord[]> {
    const raws = await this.redis.lrange(traceKey(docId), 0, -1);
    const records: AttemptRecord[] = [];
    for (const raw of raws) {
      try {
        const r = JSON.parse(raw) as AttemptRecord;
        if (!stage || r.stage === stage) records.push(r);
      } catch {
        // 跳过损坏记录
      }
    }
    return records;
  }

  async get(docId: string, attemptId: string): Promise<AttemptRecord | null> {
    return (await this.list(docId)).find((r) => r.id === attemptId) ?? null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
