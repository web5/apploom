/**
 * 幂等入队与过期 job：用真实 BullMQ + 真实 Redis 验证 jobId 去重；服务层用脚本化的存储 / 队列验证 seq 的取值与过期丢弃。
 * Redis 连不上时第一组整体跳过。
 */
jest.mock('ioredis', () => {
  const actual = jest.requireActual('ioredis');
  // 服务构造里的连接换成桩；下面真实 BullMQ 测试直接用 jest.requireActual 拿真连接
  return { __esModule: true, default: jest.fn().mockImplementation(() => ({ on: jest.fn(), quit: jest.fn() })), actual };
});

import { Queue, Worker } from 'bullmq';
import { PipelineService, stageJobId } from './pipeline.service';
import { createPipelineDoc, type AttemptRecord, type PipelineDoc, type PipelineEvent, type PipelineStage } from './pipeline.types';
import { withRun } from './test-llm';

const RealRedis = jest.requireMock('ioredis').actual.default ?? jest.requireMock('ioredis').actual;

describe('stageJobId', () => {
  it('不是纯数字（BullMQ 会拒绝），且同一意图稳定、不同意图不同', () => {
    expect(stageJobId('abc-1', 'design', 3)).toBe('abc-1__design__3');
    expect(stageJobId('abc-1', 'design', 3)).toBe(stageJobId('abc-1', 'design', 3));
    expect(stageJobId('abc-1', 'design', 3)).not.toBe(stageJobId('abc-1', 'design', 4));
    expect(stageJobId('abc-1', 'design', 3)).not.toBe(stageJobId('abc-1', 'codegen', 3));
    expect(/^\d+$/.test(stageJobId('1', 'design', 1))).toBe(false);
  });
});

describe('真实 BullMQ：相同 jobId 去重', () => {
  let reachable = false;
  const name = `apploom-idem-${Date.now()}`;
  let conn: InstanceType<typeof RealRedis>;
  let queue: Queue;
  beforeAll(async () => {
    conn = new RealRedis({ host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379), maxRetriesPerRequest: null, lazyConnect: true, retryStrategy: () => null });
    conn.on('error', () => undefined);
    try { await conn.connect(); reachable = (await conn.ping()) === 'PONG'; } catch { reachable = false; }
    if (!reachable) { console.warn('[skip] Redis 不可达，跳过 BullMQ 去重测试'); return; }
    queue = new Queue(name, { connection: conn });
  });
  afterAll(async () => {
    if (reachable) { await queue.obliterate({ force: true }); await queue.close(); }
    conn?.disconnect();
  });
  const it_ = (n: string, fn: () => Promise<void>) => it(n, async () => { if (reachable) await fn(); });

  it_('同一意图重复入队 100 次只留一个 job；不同 seq 各自独立', async () => {
    const add = (seq: number) => queue.add('design', { docId: 'd', stage: 'design', seq }, { jobId: stageJobId('d', 'design', seq) });
    await Promise.all(Array.from({ length: 100 }, () => add(1)));
    expect(await queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(1);
    await add(2);
    expect(await queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(2);
  });

  it_('job 被 worker 真实处理完成之后，再入队相同 jobId 也不会重复执行；换 seq 才会执行', async () => {
    const processed: string[] = [];
    const worker = new Worker(name, async (job) => { processed.push(job.id as string); }, { connection: conn });
    const done = (n: number) => new Promise<void>((resolve) => { const t = setInterval(() => { if (processed.length >= n) { clearInterval(t); resolve(); } }, 20); });
    try {
      await queue.obliterate({ force: true });
      const add = (seq: number) => queue.add('codegen', { docId: 'd2', stage: 'codegen', seq }, { jobId: stageJobId('d2', 'codegen', seq) });
      await add(1);
      await done(1);
      await add(1); // 迟到的重复入队（如崩溃重启后重复调度）
      await new Promise((r) => setTimeout(r, 300));
      expect(processed).toEqual(['d2__codegen__1']);
      await add(2); // 新的意图（比如重试）
      await done(2);
      expect(processed).toEqual(['d2__codegen__1', 'd2__codegen__2']);
    } finally {
      await worker.close();
    }
  });
});

class FakeStore {
  constructor(public doc: PipelineDoc) {}
  async get() { return structuredClone(this.doc); }
  async save(d: PipelineDoc) { this.doc = d; }
  async update(_id: string, fn: (d: PipelineDoc) => void) { fn(this.doc); return this.doc; }
  async mutate<T>(_id: string, fn: (d: PipelineDoc, skip: () => void) => T) {
    const result = fn(this.doc, () => undefined);
    return { doc: structuredClone(this.doc), result };
  }
}

function setup(stage: PipelineStage = 'requirement') {
  const doc = createPipelineDoc('做计数器', true);
  doc.id = 'idem';
  doc.currentStage = stage;
  const store = new FakeStore(doc);
  const events: PipelineEvent[] = [];
  const bus = { emit: jest.fn((_i: string, e: PipelineEvent) => void events.push(e)) };
  const llm = withRun({ generatePrd: jest.fn(async () => ({ raw: 'r', prd: { ok: 1 }, summary: { warnings: [] } })), generatePrototype: jest.fn(async () => ({ raw: 'r', prototype: { ok: 1 }, summary: { warnings: [] } })) } as Record<string, jest.Mock>);
  const records: AttemptRecord[] = [];
  const trace = { append: jest.fn(async (r: AttemptRecord) => void records.push(r)), list: jest.fn(async () => records) };
  const svc = new PipelineService(store as never, bus as never, llm as never, { deploy: jest.fn() } as never, { verify: jest.fn() } as never, trace as never);
  const add = jest.fn();
  (svc as unknown as { queue: unknown }).queue = { add };
  const process = (data: { docId: string; stage: PipelineStage; seq?: number }) => (svc as unknown as { processStage(j: unknown): Promise<void> }).processStage({ data });
  return { doc, svc, add, llm, process, records };
}

describe('入队序号（seq）', () => {
  beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  it('创建：第一阶段 seq=1', async () => {
    const { svc, add } = setup();
    await svc.create('做计数器', true);
    expect(add).toHaveBeenCalledWith('requirement', expect.objectContaining({ stage: 'requirement', seq: 1 }), { jobId: expect.stringMatching(/^[0-9a-f-]+__requirement__1$/) });
  });

  it('重试 / 修复：seq 随 attempts 递增，每次都是新意图；同一状态下重复修复得到相同 jobId（只会跑一次）', async () => {
    const { doc, svc, add, process } = setup();
    await process({ docId: 'idem', stage: 'requirement', seq: 1 }); // 跑完需求阶段，attempts=1，等确认
    expect(doc.stages.requirement.attempts).toBe(1);

    await svc.repair('idem', 'requirement', '加登录');
    await svc.repair('idem', 'requirement', '再加个注册'); // worker 还没来得及取，用户又改了一次
    const ids = add.mock.calls.map((c) => c[2].jobId);
    expect(ids).toEqual(['idem__requirement__2', 'idem__requirement__2']); // 同一意图，BullMQ 会去重成一个 job
    expect(doc.stages.requirement.feedback).toBe('再加个注册'); // 去重后执行时读到的是最新反馈
  });

  it('确认：下一阶段 seq 取自该阶段当前 attempts + 1；连点只入队一次', async () => {
    const { doc, svc, add, process } = setup();
    await process({ docId: 'idem', stage: 'requirement', seq: 1 });
    add.mockClear();
    await Promise.all([svc.confirm('idem', 'requirement'), svc.confirm('idem', 'requirement')]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('prototype', { docId: 'idem', stage: 'prototype', seq: 1 }, { jobId: 'idem__prototype__1' });
    expect(doc.stages.prototype.status).toBe('pending');
  });

  it('自动模式的交接：下一阶段的入队序号同样带 seq', async () => {
    const { doc, add, process } = setup();
    doc.confirmEachStep = false;
    await process({ docId: 'idem', stage: 'requirement', seq: 1 });
    expect(add).toHaveBeenCalledWith('prototype', { docId: 'idem', stage: 'prototype', seq: 1 }, { jobId: 'idem__prototype__1' });
  });
});

describe('过期 job 的丢弃', () => {
  beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => undefined); jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterAll(() => jest.restoreAllMocks());

  it('阶段已被重置为 pending，旧意图的 job 到达时直接丢弃：不调模型、不改文档', async () => {
    const { doc, llm, process, records } = setup();
    const before = structuredClone(doc);
    doc.stages.requirement.attempts = 3; // 已经历过 3 次执行，现在 pending，下一个意图应是 seq=4
    before.stages.requirement.attempts = 3;
    await process({ docId: 'idem', stage: 'requirement', seq: 2 }); // 迟到的旧 job
    expect(llm.generatePrd).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    expect(doc).toEqual(before);
  });

  it('seq 正好等于当前意图：正常执行', async () => {
    const { doc, llm, process } = setup();
    doc.stages.requirement.attempts = 3;
    await process({ docId: 'idem', stage: 'requirement', seq: 4 });
    expect(llm.generatePrd).toHaveBeenCalledTimes(1);
    expect(doc.stages.requirement).toMatchObject({ status: 'done', attempts: 4 });
  });

  it('崩溃后被重新投递：阶段停在 running，同一 seq 的 job 照常重跑（不被当成过期）', async () => {
    const { doc, llm, process } = setup();
    doc.stages.requirement.status = 'running'; // 上一次执行跑到一半进程挂了
    doc.stages.requirement.attempts = 1;
    await process({ docId: 'idem', stage: 'requirement', seq: 1 });
    expect(llm.generatePrd).toHaveBeenCalledTimes(1);
    expect(doc.stages.requirement.status).toBe('done');
  });

  it('执行完成但交接前崩溃：重新投递后只补做交接，不重复执行', async () => {
    const { doc, llm, process } = setup();
    doc.status = 'running'; // 崩溃发生在执行阶段，文档整体状态此时是 running
    doc.stages.requirement = { status: 'done', attempts: 1, result: { ok: 1 } };
    await process({ docId: 'idem', stage: 'requirement', seq: 1 });
    expect(llm.generatePrd).not.toHaveBeenCalled();
    expect(doc.handoffs.requirement).toBe(true);
    expect(doc.status).toBe('waiting_confirm');
  });

  it('老版本入队、没有 seq 的 job：保持旧行为（照常执行）', async () => {
    const { doc, llm, process } = setup();
    doc.stages.requirement.attempts = 3;
    await process({ docId: 'idem', stage: 'requirement' });
    expect(llm.generatePrd).toHaveBeenCalledTimes(1);
    expect(doc.stages.requirement.attempts).toBe(4);
  });
});
