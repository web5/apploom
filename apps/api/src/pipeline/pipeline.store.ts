/**
 * PipelineStore —— 流水线文档存储的抽象（Nest DI token）。
 *
 * 实现：Redis（pipeline.redis-store.ts，CAS 乐观并发）与 Postgres（pipeline.pg-store.ts，行锁），
 * 由 storage 模块按 STORE_BACKEND / DATABASE_URL 选择。BullMQ 只负责调度，仍然走 Redis。
 *
 * 契约（两种实现都由 pipeline.store.spec.ts 的同一套用例保证）：
 *  - 所有修改走 mutate()：读 → 同步 mutator 就地修改 → 原子写回，不丢更新，version 连续
 *  - mutator 内调用 skip() 表示守卫未通过，不写入、不涨 version
 *  - 文档不存在返回 null；老数据读出时补齐新增字段（migrateDoc）
 */
import { PIPELINE_STAGES, PipelineDoc, PipelineDocSummary, emptyStage } from './pipeline.types';

/** 并发写冲突且重试耗尽 */
export class ConflictError extends Error {
  constructor(id: string, attempts: number) {
    super(`pipeline ${id} 并发写冲突，重试 ${attempts} 次仍失败`);
    this.name = 'ConflictError';
  }
}

/** mutator 内调用 skip() 表示「检查未通过，不要写入」，避免无意义地 version++ */
export type SkipWrite = () => void;

export function toSummary(d: PipelineDoc): PipelineDocSummary {
  return {
    id: d.id,
    ownerId: d.ownerId,
    requirement: d.requirement,
    status: d.status,
    currentStage: d.currentStage,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    stages: Object.fromEntries(PIPELINE_STAGES.map((s) => [s, d.stages[s]?.status ?? 'pending'])) as PipelineDocSummary['stages'],
  };
}

/** 老数据迁移：补齐新增阶段 / handoffs / version，丢弃已删除的死字段 */
export function migrateDoc(doc: PipelineDoc): PipelineDoc {
  for (const s of PIPELINE_STAGES) {
    if (!doc.stages[s]) doc.stages[s] = emptyStage();
    if (doc.handoffs[s] === undefined) doc.handoffs[s] = false;
  }
  doc.version ??= 0;
  delete (doc as unknown as Record<string, unknown>).pendingConfirms;
  return doc;
}

export abstract class PipelineStore {
  /** 新建（或整体覆盖）文档，同时写摘要 / 索引 */
  abstract save(doc: PipelineDoc): Promise<void>;
  /** 读取文档；不存在返回 null */
  abstract get(id: string): Promise<PipelineDoc | null>;
  /**
   * 原子修改：mutator 必须是**同步**函数，所有「读—判断—写」的守卫都写在里面（Redis 实现下可能因冲突重跑）。
   * 返回 { doc: 写入后的文档, result: mutator 的返回值 }；文档不存在返回 null；mutator 调用 skip() 则不写入。
   */
  abstract mutate<T>(id: string, mutator: (doc: PipelineDoc, skip: SkipWrite) => T, maxRetries?: number): Promise<{ doc: PipelineDoc; result: T } | null>;
  abstract remove(id: string): Promise<void>;
  /** 历史项目摘要，按最后更新时间倒序。传 ownerId 时只返回该用户的（以及没有归属的老数据） */
  abstract list(ownerId?: string): Promise<PipelineDocSummary[]>;

  /** 无返回值的原子修改 */
  async update(id: string, mutator: (doc: PipelineDoc) => void): Promise<PipelineDoc | null> {
    const r = await this.mutate(id, (d) => {
      mutator(d);
    });
    return r?.doc ?? null;
  }
}
