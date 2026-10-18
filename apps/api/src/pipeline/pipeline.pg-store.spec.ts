/**
 * PgPipelineStore 集成测试：连真实 Postgres（DATABASE_URL），未配置或连不上则整体跳过。
 * 与 Redis 实现同一套契约：并发写不丢更新、version 连续、守卫在原子快照内生效、列表按更新时间倒序、老数据可读。
 */
import { createPrismaClient } from '@apploom/database';
import { randomUUID } from 'node:crypto';
import { PgPipelineStore, toJsonb } from './pipeline.pg-store';
import { createPipelineDoc, type PipelineDoc } from './pipeline.types';

const newDoc = (requirement = 'test'): PipelineDoc => {
  const d = createPipelineDoc(requirement, true);
  d.id = `store-test-${randomUUID()}`;
  return d;
};

describe('PgPipelineStore（真实 Postgres）', () => {
  let reachable = false;
  let a: PgPipelineStore;
  let b: PgPipelineStore; // 第二个连接池，模拟另一个进程
  const created: string[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      console.warn('[skip] 未设置 DATABASE_URL，跳过 PgPipelineStore 集成测试');
      return;
    }
    try {
      a = new PgPipelineStore(createPrismaClient());
      b = new PgPipelineStore(createPrismaClient());
      await a.prisma.$queryRaw`SELECT 1`;
      reachable = true;
    } catch (e) {
      console.warn(`[skip] Postgres 不可达，跳过 PgPipelineStore 集成测试: ${(e as Error).message}`);
    }
  });
  afterAll(async () => {
    if (!a) return;
    if (reachable) for (const id of created) await a.remove(id);
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  const save = async (doc: PipelineDoc) => {
    created.push(doc.id);
    await a.save(doc);
    return doc;
  };
  const it_ = (name: string, fn: () => Promise<void>, timeout = 30000) =>
    it(name, async () => {
      if (!reachable) return;
      await fn();
    }, timeout);

  it_('同一进程 100 次并发写：无丢失更新，version 连续无跳号', async () => {
    const doc = await save(newDoc());
    const versions = await Promise.all(
      Array.from({ length: 100 }, () => a.mutate(doc.id, (d) => { d.stages.requirement.attempts += 1; }).then((r) => r!.doc.version)),
    );
    const final = await a.get(doc.id);
    expect(final!.stages.requirement.attempts).toBe(100);
    expect(final!.version).toBe(100);
    expect([...versions].sort((x, y) => x - y)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it_('两个连接池（模拟两个进程）交错并发 100 次：行锁挡住跨进程冲突，仍无丢失更新', async () => {
    const doc = await save(newDoc());
    const ops = Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).mutate(doc.id, (d) => { d.stages.design.attempts += 1; }));
    const versions = (await Promise.all(ops)).map((r) => r!.doc.version);
    const final = await a.get(doc.id);
    expect(final!.stages.design.attempts).toBe(100);
    expect(final!.version).toBe(100);
    expect(new Set(versions).size).toBe(100);
  });

  it_('守卫写在 mutator 里：50 个并发「确认」只有一个通过，version 只涨一次', async () => {
    const doc = newDoc();
    doc.status = 'waiting_confirm';
    doc.currentStage = 'requirement';
    await save(doc);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (i % 2 ? a : b).mutate(doc.id, (d, skip) => {
          if (d.status !== 'waiting_confirm') { skip(); return false; }
          d.status = 'running';
          d.currentStage = 'prototype';
          return true;
        }),
      ),
    );
    expect(results.filter((r) => r!.result).length).toBe(1);
    expect((await a.get(doc.id))!.version).toBe(1);
  });

  it_('skip() 不写入也不涨 version；文档不存在返回 null；mutator 返回 Promise 直接报错', async () => {
    const doc = await save(newDoc());
    const skipped = await a.mutate(doc.id, (_d, skip) => { skip(); return 'x'; });
    expect(skipped!.result).toBe('x');
    expect((await a.get(doc.id))!.version).toBe(0);
    expect(await a.mutate('no-such-doc', () => 1)).toBeNull();
    await expect(a.mutate(doc.id, (async () => undefined) as never)).rejects.toThrow(/同步函数/);
  });

  it_('mutator 抛错时整个事务回滚：文档与 version 都不变', async () => {
    const doc = await save(newDoc());
    await expect(a.mutate(doc.id, (d) => { d.status = 'failed'; throw new Error('boom'); })).rejects.toThrow('boom');
    const got = await a.get(doc.id);
    expect(got!.status).toBe(doc.status);
    expect(got!.version).toBe(0);
  });

  it_('列表按更新时间倒序、只返回摘要；remove 后从列表消失', async () => {
    const d1 = await save(newDoc('第一个'));
    await new Promise((r) => setTimeout(r, 15));
    const d2 = await save(newDoc('第二个'));
    await new Promise((r) => setTimeout(r, 15));
    await a.mutate(d1.id, (d) => { d.status = 'running'; });

    const ids = (await a.list()).map((s) => s.id);
    expect(ids.indexOf(d1.id)).toBeLessThan(ids.indexOf(d2.id));
    const s1 = (await a.list()).find((s) => s.id === d1.id)!;
    expect(s1).toMatchObject({ requirement: '第一个', status: 'running' });
    expect(s1).not.toHaveProperty('stages.requirement.result');

    await a.remove(d2.id);
    expect((await a.list()).some((s) => s.id === d2.id)).toBe(false);
  });

  it_('老数据：缺 version / 带 pendingConfirms 的文档可读、可继续写', async () => {
    const id = `store-test-old-${randomUUID()}`;
    created.push(id);
    const old = { ...newDoc('老文档'), id } as Record<string, unknown>;
    delete old.version;
    old.pendingConfirms = ['requirement'];
    await a.prisma.$executeRaw`
      INSERT INTO "PipelineRun" ("id", "requirement", "status", "version", "doc", "summary", "updatedAt")
      VALUES (${id}, '老文档', 'running', 0, ${JSON.stringify(old)}::jsonb, '{}'::jsonb, now())`;
    const got = await a.get(id);
    expect(got!.version).toBe(0);
    expect(got).not.toHaveProperty('pendingConfirms');
    expect((await a.mutate(id, (d) => { d.status = 'running'; }))!.doc.version).toBe(1);
  });

  it_('按归属过滤列表：只看到自己的和没有归属的老数据；ownerId 随文档持久化', async () => {
    const mine = newDoc('我的'); mine.ownerId = 'alice';
    const theirs = newDoc('别人的'); theirs.ownerId = 'bob';
    const legacy = newDoc('老数据');
    await save(mine); await save(theirs); await save(legacy);
    const seen = (await a.list('alice')).map((s) => s.id);
    expect(seen).toEqual(expect.arrayContaining([mine.id, legacy.id]));
    expect(seen).not.toContain(theirs.id);
    expect((await a.list()).map((s) => s.id)).toEqual(expect.arrayContaining([mine.id, theirs.id, legacy.id]));
    expect((await a.get(mine.id))!.ownerId).toBe('alice');
    expect((await a.mutate(mine.id, (d) => { d.status = 'running'; }))!.doc.ownerId).toBe('alice');
    expect((await a.list('alice')).find((s) => s.id === mine.id)!.ownerId).toBe('alice');
  });

  it_('jsonb 不接受的字符（\\u0000、孤立代理项）写入前被清理，不会让整次写入失败', async () => {
    const doc = await save(newDoc('含\u0000怪字符\ud800'));
    const r = await a.mutate(doc.id, (d) => { d.stages.requirement.raw = 'a\u0000b\udc00c'; });
    expect(r!.doc.stages.requirement.raw).toBe('a\u0000b\udc00c'); // 返回给调用方的是内存里的原文
    const got = await a.get(doc.id);
    expect(got!.stages.requirement.raw).toBe('ab�c');
    expect(got!.requirement).toBe('含怪字符�');
    expect(toJsonb({ s: 'x\u0000' })).toBe('{"s":"x"}');
  });
});
