/**
 * PipelineStore 集成测试：连真实 Redis（localhost，或 REDIS_HOST / REDIS_PORT），连不上则整体跳过。
 * 验证：并发写不丢更新、version 连续无跳号、守卫在原子快照内生效、列表走索引、老数据迁移与补建索引。
 */
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ConflictError, PipelineStore, docKey } from './pipeline.store';
import { createPipelineDoc, type PipelineDoc } from './pipeline.types';

const host = process.env.REDIS_HOST ?? 'localhost';
const port = Number(process.env.REDIS_PORT ?? 6379);

async function redisReachable(): Promise<boolean> {
  const r = new Redis({ host, port, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 1 });
  r.on('error', () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

const newDoc = (requirement = 'test'): PipelineDoc => {
  const d = createPipelineDoc(requirement, true);
  d.id = `store-test-${randomUUID()}`;
  return d;
};

describe('PipelineStore（真实 Redis）', () => {
  let reachable = false;
  let a: PipelineStore;
  let b: PipelineStore; // 第二条连接，模拟另一个进程
  const raw = new Redis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  raw.on('error', () => undefined);
  const created: string[] = [];

  beforeAll(async () => {
    reachable = await redisReachable();
    if (!reachable) {
      console.warn(`[skip] Redis ${host}:${port} 不可达，跳过 PipelineStore 集成测试`);
      return;
    }
    await raw.connect();
    a = new PipelineStore();
    b = new PipelineStore();
  });
  afterAll(async () => {
    if (reachable) {
      for (const id of created) await a.remove(id);
      await a.onModuleDestroy();
      await b.onModuleDestroy();
    }
    raw.disconnect();
  });

  const save = async (doc: PipelineDoc) => {
    created.push(doc.id);
    await a.save(doc);
    return doc;
  };
  /** Redis 不可达时直接通过（已在 beforeAll 告警） */
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

  it_('两条连接（模拟两个进程）交错并发 100 次：CAS 挡住跨进程冲突，仍无丢失更新', async () => {
    const doc = await save(newDoc());
    const ops = Array.from({ length: 100 }, (_, i) =>
      (i % 2 ? a : b).mutate(doc.id, (d) => { d.stages.design.attempts += 1; }, 400),
    );
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
        }, 400),
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

  it_('跨进程冲突重试耗尽时抛 ConflictError，而不是悄悄覆盖', async () => {
    const doc = await save(newDoc());
    // 让 a 每次读到的都是旧版本：读完后立刻由 b 改写，CAS 必然失败
    const realGet = (a as unknown as { redis: Redis }).redis.getBuffer.bind((a as unknown as { redis: Redis }).redis);
    (a as unknown as { redis: { getBuffer: unknown } }).redis.getBuffer = async (k: string) => {
      const buf = await realGet(k);
      await b.mutate(doc.id, (d) => { d.stages.deploy.attempts += 1; });
      return buf;
    };
    try {
      await expect(a.mutate(doc.id, (d) => { d.stages.requirement.attempts += 1; }, 2)).rejects.toBeInstanceOf(ConflictError);
    } finally {
      (a as unknown as { redis: { getBuffer: unknown } }).redis.getBuffer = realGet;
    }
    expect((await a.get(doc.id))!.stages.requirement.attempts).toBe(0); // 冲突的那次写没有生效
  });

  it_('列表走索引：按更新时间倒序、只返回摘要；remove 同时清掉摘要与索引', async () => {
    const d1 = await save(newDoc('第一个'));
    await new Promise((r) => setTimeout(r, 15));
    const d2 = await save(newDoc('第二个'));
    await new Promise((r) => setTimeout(r, 15));
    await a.mutate(d1.id, (d) => { d.status = 'running'; }); // d1 更新后应排到最前

    const ids = (await a.list()).map((s) => s.id);
    expect(ids.indexOf(d1.id)).toBeLessThan(ids.indexOf(d2.id));
    const s1 = (await a.list()).find((s) => s.id === d1.id)!;
    expect(s1).toMatchObject({ requirement: '第一个', status: 'running' });
    expect(s1).not.toHaveProperty('stages.requirement.result');

    await a.remove(d2.id);
    expect((await a.list()).some((s) => s.id === d2.id)).toBe(false);
    expect(await raw.exists(`pipeline:summary:${d2.id}`)).toBe(0);
  });

  it_('老数据：缺 version / 带 pendingConfirms 的文档可读、可继续写，并能被 ensureIndex 补进列表', async () => {
    const id = `store-test-old-${randomUUID()}`;
    created.push(id);
    const old = { ...newDoc('老文档'), id } as Record<string, unknown>;
    delete old.version;
    old.pendingConfirms = ['requirement'];
    await raw.set(docKey(id), JSON.stringify(old)); // 绕过 store：没有摘要、没有索引项

    expect((await a.list()).some((s) => s.id === id)).toBe(false);
    await a.ensureIndex();
    expect((await a.list()).some((s) => s.id === id)).toBe(true);

    const got = await a.get(id);
    expect(got!.version).toBe(0);
    expect(got).not.toHaveProperty('pendingConfirms');
    const r = await a.mutate(id, (d) => { d.status = 'running'; });
    expect(r!.doc.version).toBe(1);
  });
});
