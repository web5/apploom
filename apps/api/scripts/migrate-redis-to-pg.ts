/**
 * 把 Redis 里的流水线文档与执行记录搬到 Postgres（幂等：重复执行只会覆盖同 id 文档、跳过已存在的执行记录）。
 *
 * 用法（apps/api 下，需要 DATABASE_URL 与可达的 Redis）：
 *   pnpm migrate:pg [--dry-run] [--delete-source]
 * --delete-source：迁移条数核对一致后，删除 Redis 里的 pipeline:doc / summary / trace / index（不动 BullMQ 队列的 key）。
 */
import { createPrismaClient } from '@apploom/database';
import Redis from 'ioredis';
import type { AttemptRecord, PipelineDoc } from '../src/pipeline/pipeline.types';
import { PgPipelineStore } from '../src/pipeline/pipeline.pg-store';
import { migrateDoc } from '../src/pipeline/pipeline.store';
import { PgTraceStore } from '../src/trace/trace.pg-store';

const DOC_PREFIX = 'pipeline:doc:';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const deleteSource = process.argv.includes('--delete-source');
  if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');

  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  });
  const prisma = createPrismaClient();
  const docs = new PgPipelineStore(prisma);
  const traces = new PgTraceStore(prisma);

  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${DOC_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  let movedDocs = 0;
  let movedAttempts = 0;
  const bad: string[] = [];
  const moved: string[] = [];
  for (const key of keys) {
    const id = key.slice(DOC_PREFIX.length);
    let doc: PipelineDoc;
    try {
      doc = migrateDoc(JSON.parse((await redis.get(key)) ?? 'null') as PipelineDoc);
    } catch {
      bad.push(id);
      continue;
    }
    if (!doc?.id) {
      bad.push(id);
      continue;
    }
    if (!dryRun) await docs.save(doc);
    movedDocs++;
    moved.push(id);

    const raws = await redis.lrange(`pipeline:trace:${id}`, 0, -1);
    for (const raw of raws) {
      try {
        const rec = JSON.parse(raw) as AttemptRecord;
        if (!dryRun) await traces.append(rec);
        movedAttempts++;
      } catch {
        // 损坏的执行记录直接丢弃
      }
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}文档 ${movedDocs}/${keys.length}，执行记录 ${movedAttempts} 条${bad.length ? `，损坏跳过: ${bad.join(', ')}` : ''}`);

  if (deleteSource && !dryRun) {
    const inPg = await prisma.pipelineRun.count({ where: { id: { in: moved } } });
    if (inPg !== moved.length) throw new Error(`核对失败：Postgres 中只有 ${inPg}/${moved.length} 份，未删除 Redis 源数据`);
    for (const id of moved) {
      await redis.multi().del(`${DOC_PREFIX}${id}`).del(`pipeline:summary:${id}`).del(`pipeline:trace:${id}`).zrem('pipeline:index', id).exec();
    }
    console.log(`已删除 Redis 中 ${moved.length} 份文档的源数据`);
  }

  await redis.quit();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
