/**
 * PgPipelineStore —— 流水线文档的 Postgres 存储（表 PipelineRun，见 packages/database/prisma/schema.prisma）。
 *
 * 与 Redis 实现语义一致：所有修改走 mutate()——事务内 `SELECT … FOR UPDATE` 锁住该行 → 同步 mutator 就地修改 → 同事务写回。
 * 行锁天然串行化跨进程并发，不会有 CAS 冲突重试；mutator 因此只会执行一次。
 * 摘要（列表用）、status / currentStage / requirement 等冗余列与文档在同一条 UPDATE 里写入，永远一致。
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, createPrismaClient } from '@apploom/database';
import type { PipelineDoc, PipelineDocSummary } from './pipeline.types';
import { PipelineStore, migrateDoc, toSummary, type SkipWrite } from './pipeline.store';

/** Postgres 的 jsonb 不接受 \u0000 与孤立代理项；模型输出里偶发这类字符，写入前清掉，避免整次写入失败 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const cleanText = (s: string): string => s.replace(/\u0000/g, '').replace(LONE_SURROGATE, '\ufffd');
export function toJsonb(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'string' ? cleanText(v) : v));
}

@Injectable()
export class PgPipelineStore extends PipelineStore implements OnModuleDestroy {
  readonly prisma: PrismaClient;
  /** 进程内按 id 排队：同进程的并发写不必都去抢行锁 */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(prisma?: PrismaClient) {
    super();
    this.prisma = prisma ?? createPrismaClient();
  }

  async save(doc: PipelineDoc): Promise<void> {
    const json = toJsonb(doc);
    const summary = toJsonb(toSummary(doc));
    const updatedAt = new Date(doc.updatedAt);
    await this.prisma.$executeRaw`
      INSERT INTO "PipelineRun" ("id", "requirement", "status", "currentStage", "version", "doc", "summary", "createdAt", "updatedAt")
      VALUES (${doc.id}, ${cleanText(doc.requirement)}, ${doc.status}, ${doc.currentStage}, ${doc.version ?? 0}, ${json}::jsonb, ${summary}::jsonb, ${new Date(doc.createdAt)}, ${updatedAt})
      ON CONFLICT ("id") DO UPDATE SET
        "requirement" = EXCLUDED."requirement", "status" = EXCLUDED."status", "currentStage" = EXCLUDED."currentStage",
        "version" = EXCLUDED."version", "doc" = EXCLUDED."doc", "summary" = EXCLUDED."summary", "updatedAt" = EXCLUDED."updatedAt"`;
  }

  async get(id: string): Promise<PipelineDoc | null> {
    const row = await this.prisma.pipelineRun.findUnique({ where: { id }, select: { doc: true } });
    return row ? migrateDoc(row.doc as unknown as PipelineDoc) : null;
  }

  async mutate<T>(id: string, mutator: (doc: PipelineDoc, skip: SkipWrite) => T): Promise<{ doc: PipelineDoc; result: T } | null> {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const run = prev.then(() => this.mutateOnce(id, mutator));
    const tail = run.catch(() => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return run;
  }

  private mutateOnce<T>(id: string, mutator: (doc: PipelineDoc, skip: SkipWrite) => T): Promise<{ doc: PipelineDoc; result: T } | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ doc: unknown }[]>`SELECT "doc" FROM "PipelineRun" WHERE "id" = ${id} FOR UPDATE`;
        if (rows.length === 0) return null;
        const doc = migrateDoc(rows[0].doc as PipelineDoc);

        let skipped = false;
        const result = mutator(doc, () => {
          skipped = true;
        });
        if (result instanceof Promise) throw new Error('PipelineStore.mutate 的 mutator 必须是同步函数');
        if (skipped) return { doc, result };

        doc.version += 1;
        doc.updatedAt = new Date().toISOString();
        await tx.$executeRaw`
          UPDATE "PipelineRun" SET "requirement" = ${cleanText(doc.requirement)}, "status" = ${doc.status}, "currentStage" = ${doc.currentStage},
            "version" = ${doc.version}, "doc" = ${toJsonb(doc)}::jsonb, "summary" = ${toJsonb(toSummary(doc))}::jsonb, "updatedAt" = ${new Date(doc.updatedAt)}
          WHERE "id" = ${id}`;
        return { doc, result };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  }

  async remove(id: string): Promise<void> {
    await this.prisma.pipelineRun.deleteMany({ where: { id } });
  }

  async list(): Promise<PipelineDocSummary[]> {
    const rows = await this.prisma.pipelineRun.findMany({ orderBy: { updatedAt: 'desc' }, select: { summary: true } });
    return rows.map((r) => r.summary as unknown as PipelineDocSummary);
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
