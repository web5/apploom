/**
 * PipelineStore —— 流水线文档的 Redis 存储
 *
 * 事实来源：`pipeline:doc:{id}` 一个 JSON key。
 * BullMQ 只负责「调度任务」，任务状态与各阶段产出都存这里，
 * 好处是重试/重启后能完整恢复，不会被 BullMQ job 的 TTL 清掉。
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { PipelineDoc } from './pipeline.types';

const DOC_KEY_PREFIX = 'pipeline:doc:';

export function docKey(id: string): string {
  return `${DOC_KEY_PREFIX}${id}`;
}

@Injectable()
export class PipelineStore implements OnModuleDestroy {
  private readonly logger = new Logger(PipelineStore.name);
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: false,
      maxRetriesPerRequest: null, // BullMQ 要求
    });
    this.redis.on('error', (e) => this.logger.warn(`Redis 连接错误: ${e.message}`));
  }

  async save(doc: PipelineDoc): Promise<void> {
    await this.redis.set(docKey(doc.id), JSON.stringify(doc));
  }

  /** 读取文档；不存在返回 null */
  async get(id: string): Promise<PipelineDoc | null> {
    const raw = await this.redis.get(docKey(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PipelineDoc;
    } catch {
      this.logger.error(`pipeline ${id} 文档 JSON 损坏`);
      return null;
    }
  }

  /** 乐观更新：读当前文档 → mutator 就地修改 → 写回，并刷新 updatedAt */
  async update(id: string, mutator: (doc: PipelineDoc) => void): Promise<PipelineDoc | null> {
    const doc = await this.get(id);
    if (!doc) return null;
    mutator(doc);
    doc.updatedAt = new Date().toISOString();
    await this.save(doc);
    return doc;
  }

  async remove(id: string): Promise<void> {
    await this.redis.del(docKey(id));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
