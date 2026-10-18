/**
 * RedisPipelineStore —— 流水线文档的 Redis 存储（STORE_BACKEND=redis 或未配置 DATABASE_URL 时使用）
 *
 * 事实来源：`pipeline:doc:{id}` 一个 JSON key。
 * BullMQ 只负责「调度任务」，任务状态与各阶段产出都存这里，
 * 好处是重试/重启后能完整恢复，不会被 BullMQ job 的 TTL 清掉。
 *
 * 并发：所有修改都走 mutate()——读 → 同步 mutator 就地修改 → Lua「比较并写入」（CAS）。
 * 写入时服务端校验文档内容哈希仍是读到的那一份，否则返回冲突并重试，因此不会丢更新。
 * 不用 WATCH/MULTI：WATCH 是连接级状态，本进程所有调用共用一条连接，一次 EXEC/UNWATCH
 * 会清掉其它并发调用的监视，反而会漏掉冲突。
 *
 * 辅助结构（与文档在同一个 Lua 脚本里原子写入）：
 *   pipeline:summary:{id}   列表用的摘要，列表接口不必解析整份文档
 *   pipeline:index          zset，score = 最后更新时间，列表不再 SCAN 全表
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { PipelineDoc, PipelineDocSummary } from './pipeline.types';
import { ConflictError, PipelineStore, migrateDoc, toSummary, type SkipWrite } from './pipeline.store';

const DOC_KEY_PREFIX = 'pipeline:doc:';
const SUMMARY_KEY_PREFIX = 'pipeline:summary:';
const INDEX_KEY = 'pipeline:index';

export function docKey(id: string): string {
  return `${DOC_KEY_PREFIX}${id}`;
}
const summaryKey = (id: string) => `${SUMMARY_KEY_PREFIX}${id}`;

/**
 * 比较并写入。返回 1 = 已写入；0 = 文档已被别人改过（冲突）；-1 = 文档不存在。
 * 哈希在服务端按存储的原始字节计算，客户端对读到的同一份字节算哈希，二者必然一致。
 */
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return -1 end
if redis.sha1hex(cur) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
return 1
`;

interface CasRedis extends Redis {
  pipelineCas(docKey: string, summaryKey: string, indexKey: string, expectedSha1: string, doc: string, summary: string, score: string, id: string): Promise<number>;
}

const sha1 = (buf: Buffer) => createHash('sha1').update(buf).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class RedisPipelineStore extends PipelineStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPipelineStore.name);
  private readonly redis: CasRedis;
  /** 进程内按 id 排队：同一个进程里的并发写不必互相冲突重试，CAS 只用来挡跨进程的并发 */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor() {
    super();
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: false,
      maxRetriesPerRequest: null, // BullMQ 要求
    });
    redis.defineCommand('pipelineCas', { numberOfKeys: 3, lua: CAS_SCRIPT });
    this.redis = redis as CasRedis;
    this.redis.on('error', (e) => this.logger.warn(`Redis 连接错误: ${e.message}`));
  }

  /** 启动时把老文档补进索引（升级前写入的文档没有摘要与索引项；幂等） */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureIndex();
    } catch (e) {
      this.logger.warn(`文档索引补建失败（列表可能不完整，下次启动重试）: ${(e as Error).message}`);
    }
  }

  async ensureIndex(): Promise<number> {
    let cursor = '0';
    let added = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${DOC_KEY_PREFIX}*`, 'COUNT', 200);
      cursor = next;
      for (const key of keys) {
        const id = key.slice(DOC_KEY_PREFIX.length);
        if ((await this.redis.zscore(INDEX_KEY, id)) !== null && (await this.redis.exists(summaryKey(id)))) continue;
        const doc = await this.get(id);
        if (!doc) continue;
        await this.redis.multi().set(summaryKey(id), JSON.stringify(toSummary(doc))).zadd(INDEX_KEY, Date.parse(doc.updatedAt) || Date.now(), id).exec();
        added++;
      }
    } while (cursor !== '0');
    if (added > 0) this.logger.log(`已为 ${added} 份老文档补建摘要与索引`);
    return added;
  }

  /** 新建（或整体覆盖）文档：同时写摘要与索引，一个事务 */
  async save(doc: PipelineDoc): Promise<void> {
    await this.redis
      .multi()
      .set(docKey(doc.id), JSON.stringify(doc))
      .set(summaryKey(doc.id), JSON.stringify(toSummary(doc)))
      .zadd(INDEX_KEY, Date.parse(doc.updatedAt) || Date.now(), doc.id)
      .exec();
  }

  private parse(raw: Buffer, id: string): PipelineDoc | null {
    try {
      return migrateDoc(JSON.parse(raw.toString('utf8')) as PipelineDoc);
    } catch {
      this.logger.error(`pipeline ${id} 文档 JSON 损坏`);
      return null;
    }
  }

  /** 读取文档；不存在返回 null。对旧数据做迁移容错 */
  async get(id: string): Promise<PipelineDoc | null> {
    const raw = await this.redis.getBuffer(docKey(id));
    return raw ? this.parse(raw, id) : null;
  }

  /**
   * 原子修改：mutator 必须是**同步**函数（里面不能 await），并且可能因冲突被重新执行，
   * 所以所有「读—判断—写」的守卫都要写在 mutator 里面——只有在这里，判断用的才是即将被覆盖的那一份数据。
   * 返回 { doc: 写入后的文档, result: mutator 的返回值 }；文档不存在返回 null；
   * mutator 调用了 skip() 则不写入，doc 为当前文档。
   */
  async mutate<T>(
    id: string,
    mutator: (doc: PipelineDoc, skip: SkipWrite) => T,
    maxRetries = Number(process.env.STORE_MAX_RETRIES ?? 8),
  ): Promise<{ doc: PipelineDoc; result: T } | null> {
    // 进程内串行：同一 id 的 mutate 排队执行
    const prev = this.queues.get(id) ?? Promise.resolve();
    const run = prev.then(() => this.mutateOnce(id, mutator, maxRetries));
    const tail = run.catch(() => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return run;
  }

  private async mutateOnce<T>(
    id: string,
    mutator: (doc: PipelineDoc, skip: SkipWrite) => T,
    maxRetries: number,
  ): Promise<{ doc: PipelineDoc; result: T } | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const raw = await this.redis.getBuffer(docKey(id));
      if (!raw) return null;
      const doc = this.parse(raw, id);
      if (!doc) return null;

      let skipped = false;
      const result = mutator(doc, () => {
        skipped = true;
      });
      if (result instanceof Promise) throw new Error('PipelineStore.mutate 的 mutator 必须是同步函数');
      if (skipped) return { doc, result };

      doc.version += 1;
      doc.updatedAt = new Date().toISOString();
      const code = await this.redis.pipelineCas(
        docKey(id),
        summaryKey(id),
        INDEX_KEY,
        sha1(raw),
        JSON.stringify(doc),
        JSON.stringify(toSummary(doc)),
        String(Date.parse(doc.updatedAt)),
        id,
      );
      if (code === 1) return { doc, result };
      if (code === -1) return null;
      // 跨进程冲突：带抖动的指数退避后重读重试
      await sleep(Math.min(200, 10 * 2 ** attempt) * (0.5 + Math.random()));
    }
    throw new ConflictError(id, maxRetries + 1);
  }

  async remove(id: string): Promise<void> {
    await this.redis.multi().del(docKey(id)).del(summaryKey(id)).zrem(INDEX_KEY, id).exec();
  }

  /** 列出历史项目摘要，按最后更新时间倒序（走 zset 索引与摘要 key，不解析整份文档） */
  async list(ownerId?: string): Promise<PipelineDocSummary[]> {
    const ids = await this.redis.zrevrange(INDEX_KEY, 0, -1);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map(summaryKey));
    const out: PipelineDocSummary[] = [];
    raws.forEach((raw, i) => {
      if (!raw) return;
      try {
        const summary = JSON.parse(raw) as PipelineDocSummary;
        if (!ownerId || !summary.ownerId || summary.ownerId === ownerId) out.push(summary);
      } catch {
        this.logger.error(`pipeline ${ids[i]} 摘要 JSON 损坏`);
      }
    });
    return out;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
