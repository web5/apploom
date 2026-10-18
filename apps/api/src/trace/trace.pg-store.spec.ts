/**
 * PgTraceStore 集成测试：连真实 Postgres（DATABASE_URL），未配置或连不上则整体跳过。
 */
import { createPrismaClient } from '@apploom/database';
import { randomUUID } from 'node:crypto';
import { PgPipelineStore } from '../pipeline/pipeline.pg-store';
import { createPipelineDoc, type AttemptRecord } from '../pipeline/pipeline.types';
import { PgTraceStore } from './trace.pg-store';
import { MAX_ATTEMPTS } from './trace.store';

const rec = (docId: string, n: number, stage: AttemptRecord['stage'] = 'requirement'): AttemptRecord => ({
  id: `att-${randomUUID()}`,
  docId,
  stage,
  n,
  trigger: 'initial',
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: 1,
  outcome: 'done',
  usage: { promptTokens: 1, completionTokens: 1 },
  llmCalls: 1,
  llmLogs: [],
});

describe('PgTraceStore（真实 Postgres）', () => {
  let reachable = false;
  const prisma = createPrismaClient();
  const docs = new PgPipelineStore(prisma);
  const traces = new PgTraceStore(prisma);
  let docId = '';

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return console.warn('[skip] 未设置 DATABASE_URL，跳过 PgTraceStore 集成测试');
    try {
      const d = createPipelineDoc('trace test', true);
      d.id = `trace-test-${randomUUID()}`;
      docId = d.id;
      await docs.save(d);
      reachable = true;
    } catch (e) {
      console.warn(`[skip] Postgres 不可达: ${(e as Error).message}`);
    }
  });
  afterAll(async () => {
    if (reachable) await docs.remove(docId); // 外键级联会带走执行记录
    await prisma.$disconnect();
  });
  const it_ = (name: string, fn: () => Promise<void>) => it(name, async () => { if (reachable) await fn(); }, 30000);

  it_('追加后按写入顺序读出，可按阶段过滤，可按 id 取单条；重复 id 不会写两遍', async () => {
    const a = rec(docId, 1, 'requirement');
    const b = rec(docId, 1, 'prototype');
    await traces.append(a);
    await traces.append(b);
    await traces.append(a);
    expect((await traces.list(docId)).map((r) => r.id)).toEqual([a.id, b.id]);
    expect((await traces.list(docId, 'prototype')).map((r) => r.id)).toEqual([b.id]);
    expect((await traces.get(docId, a.id))!.stage).toBe('requirement');
    expect(await traces.get(docId, 'nope')).toBeNull();
  });

  it_(`只保留最近 ${MAX_ATTEMPTS} 条`, async () => {
    for (let i = 0; i < MAX_ATTEMPTS + 5; i++) await traces.append(rec(docId, i));
    const all = await traces.list(docId);
    expect(all).toHaveLength(MAX_ATTEMPTS);
    expect(all[all.length - 1].n).toBe(MAX_ATTEMPTS + 4);
  });

  it_('不存在的流水线：写入只告警不抛错；删除流水线级联清掉执行记录', async () => {
    await expect(traces.append(rec('no-such-doc', 1))).resolves.toBeUndefined();
    await docs.remove(docId);
    expect(await traces.list(docId)).toEqual([]);
  });
});
