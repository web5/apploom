/**
 * PgTraceStore —— 阶段执行记录的 Postgres 实现（表 PipelineAttempt，追加式，每条流水线只保留最近 MAX_ATTEMPTS 条）。
 * 外键指向 PipelineRun：流水线删除时记录级联删除。
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, createPrismaClient } from '@apploom/database';
import type { AttemptRecord, PipelineStage } from '../pipeline/pipeline.types';
import { toJsonb } from '../pipeline/pipeline.pg-store';
import { MAX_ATTEMPTS, TraceStore } from './trace.store';

@Injectable()
export class PgTraceStore extends TraceStore implements OnModuleDestroy {
  private readonly logger = new Logger(PgTraceStore.name);
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    super();
    this.prisma = prisma ?? createPrismaClient();
  }

  /** 追加一条记录；trace 写失败只告警，绝不影响流水线主流程 */
  async append(record: AttemptRecord): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "PipelineAttempt" ("runId", "attemptId", "stage", "record")
        VALUES (${record.docId}, ${record.id}, ${record.stage}, ${toJsonb(record)}::jsonb)
        ON CONFLICT ("runId", "attemptId") DO NOTHING`;
      await this.prisma.$executeRaw`
        DELETE FROM "PipelineAttempt" WHERE "runId" = ${record.docId}
          AND "seq" NOT IN (SELECT "seq" FROM "PipelineAttempt" WHERE "runId" = ${record.docId} ORDER BY "seq" DESC LIMIT ${MAX_ATTEMPTS})`;
    } catch (e) {
      this.logger.warn(`trace 写入失败 doc=${record.docId} stage=${record.stage}: ${(e as Error).message}`);
    }
  }

  async list(docId: string, stage?: PipelineStage): Promise<AttemptRecord[]> {
    const rows = await this.prisma.pipelineAttempt.findMany({
      where: { runId: docId, ...(stage ? { stage } : {}) },
      orderBy: { seq: 'asc' },
      select: { record: true },
    });
    return rows.map((r) => r.record as unknown as AttemptRecord);
  }

  async get(docId: string, attemptId: string): Promise<AttemptRecord | null> {
    const row = await this.prisma.pipelineAttempt.findUnique({ where: { runId_attemptId: { runId: docId, attemptId } }, select: { record: true } });
    return row ? (row.record as unknown as AttemptRecord) : null;
  }

  async remove(docId: string): Promise<void> {
    await this.prisma.pipelineAttempt.deleteMany({ where: { runId: docId } });
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
