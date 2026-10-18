jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ on: jest.fn(), quit: jest.fn() })),
}));

import { LlmError, type LlmLogEntry } from '@apploom/llm';
import { PipelineService } from './pipeline.service';
import { withRun } from './test-llm';
import { createPipelineDoc, type AttemptRecord, type PipelineDoc, type PipelineStage } from './pipeline.types';

class FakeStore {
  constructor(public doc: PipelineDoc) {}
  async get() {
    return structuredClone(this.doc);
  }
  async update(_id: string, fn: (d: PipelineDoc) => void) {
    fn(this.doc);
    return this.doc;
  }
  async mutate<T>(_id: string, fn: (d: PipelineDoc, skip: () => void) => T) {
    const result = fn(this.doc, () => undefined);
    return { doc: structuredClone(this.doc), result };
  }
}

const usage = { promptTokens: 100, completionTokens: 50 };
const logEntry = (label: string): LlmLogEntry => ({ label, ts: new Date().toISOString(), user: 'u', response: 'r', usage });

function setup(stage: PipelineStage = 'requirement') {
  const doc = createPipelineDoc('做一个待办应用', false);
  doc.id = 'doc1';
  doc.currentStage = stage;
  const store = new FakeStore(doc);
  const bus = { emit: jest.fn() };
  const llm = withRun({ generatePrd: jest.fn(), generateDeploy: jest.fn() } as Record<string, jest.Mock>);
  const records: AttemptRecord[] = [];
  const trace = { append: jest.fn(async (r: AttemptRecord) => void records.push(r)), list: jest.fn(async () => records) };
  const deploySvc = { deploy: jest.fn() };
  const svc = new PipelineService(store as never, bus as never, llm as never, deploySvc as never, { verify: jest.fn() } as never, trace as never);
  (svc as unknown as { queue: unknown }).queue = { add: jest.fn() };
  const run = () => (svc as unknown as { processStage(j: unknown): Promise<void> }).processStage({ data: { docId: 'doc1', stage } });
  return { doc, llm, deploySvc, records, run, bus, trace, svc, queue: (svc as unknown as { queue: { add: jest.Mock } }).queue };
}

describe('阶段执行：错误分类 + 自动修复 + trace', () => {
  beforeEach(() => process.env.STAGE_AUTO_REPAIRS = '1');

  it('模型输出不合规 → 自动回喂校验错误重试一次 → 成功；两次执行都有 trace', async () => {
    const { doc, llm, records, run } = setup();
    llm.generatePrd
      .mockImplementationOnce(async (_req, _tok, _repair, onLog) => {
        onLog(logEntry('prd#1'));
        return { raw: '{bad', error: 'JSON 解析失败: Unexpected token' };
      })
      .mockImplementationOnce(async (_req, _tok, _repair, onLog) => {
        onLog(logEntry('prd#2'));
        return { raw: '{}', prd: { ok: 1 }, summary: { features: 1 } };
      });

    await run();

    expect(llm.generatePrd).toHaveBeenCalledTimes(2);
    const secondRepair = llm.generatePrd.mock.calls[1][2];
    expect(secondRepair.feedback).toContain('JSON 解析失败');
    expect(secondRepair.previousError).toContain('JSON 解析失败');

    expect(doc.stages.requirement).toMatchObject({ status: 'done', result: { ok: 1 } });
    expect(records.map((r) => [r.n, r.trigger, r.outcome, r.errorClass])).toEqual([
      [1, 'initial', 'failed', 'invalid_output'],
      [2, 'auto-repair', 'done', undefined],
    ]);
    expect(records[0].usage).toEqual(usage);
    expect(records[0].llmLogs[0].label).toBe('prd#1');
  });

  it('自动修复轮数用尽仍不合规 → 失败并记录 invalid_output，llmLogs 落盘', async () => {
    const { doc, llm, records, run } = setup();
    llm.generatePrd.mockImplementation(async (_r, _t, _p, onLog) => {
      onLog(logEntry('prd'));
      return { raw: 'x', error: 'schema 校验失败' };
    });

    await expect(run()).rejects.toThrow('schema 校验失败');

    expect(llm.generatePrd).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(2);
    expect(doc.stages.requirement).toMatchObject({ status: 'failed', errorClass: 'invalid_output', error: 'schema 校验失败' });
    expect(doc.stages.requirement.llmLogs).toHaveLength(1);
    expect(doc.status).toBe('failed');
  });

  it('权限类错误（401）不自动修复，一次失败；异常路径也有 trace 与已收集的日志', async () => {
    const { doc, llm, records, run } = setup();
    llm.generatePrd.mockImplementation(async (_r, _t, _p, onLog) => {
      onLog({ ...logEntry('prd'), errorClass: 'permission', error: '401' });
      throw new LlmError('LLM 请求失败 401', 'permission', 401);
    });

    await expect(run()).rejects.toThrow('401');

    expect(llm.generatePrd).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'failed', errorClass: 'permission', llmCalls: 1 });
    expect(doc.stages.requirement).toMatchObject({ errorClass: 'permission' });
    expect(doc.stages.requirement.llmLogs).toHaveLength(1);
  });

  it('STAGE_AUTO_REPAIRS=0 关闭自动修复', async () => {
    process.env.STAGE_AUTO_REPAIRS = '0';
    const { llm, records, run } = setup();
    llm.generatePrd.mockResolvedValue({ raw: 'x', error: 'bad' });
    await expect(run()).rejects.toThrow('bad');
    expect(llm.generatePrd).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
  });

  it('用户带反馈修复时 trigger=repair，自动修复轮会保留用户反馈', async () => {
    const { doc, llm, records, run } = setup();
    doc.stages.requirement.feedback = '加上登录';
    doc.stages.requirement.history = [{ result: { old: 1 } }];
    llm.generatePrd.mockResolvedValueOnce({ raw: 'x', error: 'bad json' }).mockResolvedValueOnce({ raw: '{}', prd: {}, summary: {} });

    await run();

    expect(records[0].trigger).toBe('repair');
    const autoRepair = llm.generatePrd.mock.calls[1][2];
    expect(autoRepair.feedback).toContain('加上登录');
    expect(autoRepair.feedback).toContain('bad json');
    expect(autoRepair.previous).toEqual({ old: 1 });
  });

  it('被截断 → 自动重试带放大级别与精简要求；之后若变为不合规，放大级别保持，用户反馈保留', async () => {
    const { doc, llm, records, run } = setup();
    process.env.STAGE_AUTO_REPAIRS = '2';
    doc.stages.requirement.feedback = '加上登录';
    llm.generatePrd
      .mockResolvedValueOnce({ raw: '{"a":', error: '被截断', errorClass: 'truncated' })
      .mockResolvedValueOnce({ raw: 'x', error: 'schema 校验失败' })
      .mockResolvedValueOnce({ raw: '{}', prd: {}, summary: {} });

    await run();

    const [, , second] = [0, 1, 2].map((i) => llm.generatePrd.mock.calls[i][2]);
    expect(llm.generatePrd.mock.calls[1][2]).toMatchObject({ maxTokensLevel: 1 });
    expect(llm.generatePrd.mock.calls[1][2].feedback).toContain('加上登录');
    expect(llm.generatePrd.mock.calls[1][2].feedback).toContain('精简');
    expect(second).toMatchObject({ maxTokensLevel: 1 });
    expect(records.map((r) => r.errorClass)).toEqual(['truncated', 'invalid_output', undefined]);
  });

  it('STAGE_AUTO_REPAIRS=0：截断也不自动重试，以 truncated 失败', async () => {
    process.env.STAGE_AUTO_REPAIRS = '0';
    const { doc, llm, run } = setup();
    llm.generatePrd.mockResolvedValue({ raw: '{"a":', error: '被截断', errorClass: 'truncated' });
    await expect(run()).rejects.toThrow('被截断');
    expect(llm.generatePrd).toHaveBeenCalledTimes(1);
    expect(doc.stages.requirement).toMatchObject({ status: 'failed', errorClass: 'truncated' });
  });

  describe('并发一致性', () => {
    it('逐步确认连点：状态检查在原子修改内，只有一次通过、只入队一次', async () => {
      const { doc, svc, queue } = setup();
      doc.status = 'waiting_confirm';
      doc.currentStage = 'requirement';
      doc.stages.requirement.status = 'done';

      const results = await Promise.all([svc.confirm('doc1', 'requirement'), svc.confirm('doc1', 'requirement'), svc.confirm('doc1', 'requirement')]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith('prototype', { docId: 'doc1', stage: 'prototype' });
      expect(doc.currentStage).toBe('prototype');
    });

    it('阶段运行期间用户点了「修改」：旧执行跑完后丢弃结果，不覆盖修复后的新状态', async () => {
      const { doc, llm, svc, bus, run } = setup();
      llm.generatePrd.mockImplementation(async (_r, _t, _p, onLog) => {
        onLog(logEntry('prd'));
        expect(await svc.repair('doc1', 'requirement', '加上登录')).toBe(true); // 运行中途被修复请求取代
        return { raw: '{}', prd: { stale: true }, summary: { features: 1 } };
      });

      await run(); // 不应抛错：被取代不是失败

      expect(doc.stages.requirement.status).toBe('pending'); // 仍是修复后的待执行态
      expect(doc.stages.requirement.result).toBeUndefined();
      expect(doc.stages.requirement.feedback).toBe('加上登录');
      expect(doc.handoffs.requirement).toBe(false);
      const stageEvents = bus.emit.mock.calls.map((c) => c[1]).filter((e) => e.type === 'stage').map((e) => e.status);
      expect(stageEvents).not.toContain('done');
    });

    it('被取代的执行失败了也不能把新状态改成 failed', async () => {
      const { doc, llm, svc, run } = setup();
      llm.generatePrd.mockImplementation(async () => {
        await svc.repair('doc1', 'requirement', '换个思路');
        throw new LlmError('LLM 请求失败 401', 'permission', 401);
      });

      await run();

      expect(doc.stages.requirement.status).toBe('pending');
      expect(doc.stages.requirement.errorClass).toBeUndefined();
      expect(doc.status).toBe('running');
    });
  });

  describe('token 预算熔断', () => {
    afterEach(() => delete process.env.PIPELINE_TOKEN_BUDGET);

    it('累计用量已达上限：不调用模型，直接 budget 失败且不自动修复', async () => {
      process.env.PIPELINE_TOKEN_BUDGET = '100';
      const { doc, llm, records, run } = setup();
      records.push({ usage: { promptTokens: 80, completionTokens: 40 } } as AttemptRecord);

      await expect(run()).rejects.toThrow('token 预算已用尽');

      expect(llm.generatePrd).not.toHaveBeenCalled();
      expect(doc.stages.requirement).toMatchObject({ status: 'failed', errorClass: 'budget' });
      expect(records.at(-1)).toMatchObject({ outcome: 'failed', errorClass: 'budget', llmCalls: 0 });
    });

    it('自动修复前预算耗尽：首轮失败后不再发起第二次调用', async () => {
      process.env.PIPELINE_TOKEN_BUDGET = '150';
      const { doc, llm, records, run } = setup();
      llm.generatePrd.mockImplementation(async (_r, _t, _p, onLog) => {
        onLog(logEntry('prd'));
        return { raw: 'x', error: 'bad json' };
      });

      await expect(run()).rejects.toThrow('token 预算已用尽');

      expect(llm.generatePrd).toHaveBeenCalledTimes(1);
      expect(records.map((r) => r.errorClass)).toEqual(['invalid_output', 'budget']);
      expect(doc.stages.requirement.errorClass).toBe('budget');
    });

    it('PIPELINE_TOKEN_BUDGET=0 不限制', async () => {
      process.env.PIPELINE_TOKEN_BUDGET = '0';
      const { doc, llm, records, run } = setup();
      records.push({ usage: { promptTokens: 9_000_000, completionTokens: 0 } } as AttemptRecord);
      llm.generatePrd.mockResolvedValue({ raw: '{}', prd: {}, summary: {} });

      await run();

      expect(doc.stages.requirement.status).toBe('done');
    });
  });

  it('trace 读取失败时预算基线退化为文档内已保存日志的用量，而不是 0（不会 fail-open）', async () => {
    process.env.PIPELINE_TOKEN_BUDGET = '1000';
    const { doc, llm, trace, run } = setup();
    trace.list.mockRejectedValue(new Error('redis down'));
    doc.stages.prototype.llmLogs = [{ ...logEntry('old'), usage: { promptTokens: 900, completionTokens: 300 } }];

    await expect(run()).rejects.toThrow('token 预算已用尽');

    expect(llm.generatePrd).not.toHaveBeenCalled();
    expect(doc.stages.requirement.errorClass).toBe('budget');
    delete process.env.PIPELINE_TOKEN_BUDGET;
  });

  it.each([
    ['prototype', {}, '需求拆解'],
    ['design', { requirement: { ok: 1 } }, '产品原型'],
    ['codegen', { design: { ok: 1 } }, '产品原型'],
  ] as const)('上游产物缺失：%s 阶段直接以 invalid_input 失败，不调用模型', async (stage, have, missingLabel) => {
    const { doc, llm, records, run } = setup(stage);
    for (const [k, v] of Object.entries(have)) (doc.stages as Record<string, { result?: unknown }>)[k].result = v;
    (llm as Record<string, unknown>).generatePrototype = jest.fn();
    (llm as Record<string, unknown>).generateDesign = jest.fn();
    (llm as Record<string, unknown>).generateCodegen = jest.fn();

    await expect(run()).rejects.toThrow(`上游「${missingLabel}」产物缺失`);

    for (const fn of ['generatePrototype', 'generateDesign', 'generateCodegen']) expect((llm as Record<string, jest.Mock>)[fn]).not.toHaveBeenCalled();
    expect(doc.stages[stage]).toMatchObject({ status: 'failed', errorClass: 'invalid_input' });
    expect(records).toHaveLength(1); // invalid_input 不触发自动修复
  });

  it('deploy 本地执行失败：errorClass=execution，保留 result 供诊断，不触发自动修复', async () => {
    const { doc, llm, deploySvc, records, run } = setup('deploy');
    doc.stages.codegen.result = { files: [{ path: 'a', content: 'b' }], dependencies: [], runCommand: 'npm start' };
    llm.generateDeploy.mockResolvedValue({
      raw: '{}',
      deploy: { target: 'local', url: '', repoUrl: '', buildLog: '', status: 'failed', port: 5173 },
      summary: { warnings: [] },
    });
    deploySvc.deploy.mockResolvedValue({ url: '', buildLog: 'install 失败', status: 'failed' });

    await expect(run()).rejects.toThrow('stage deploy failed');

    expect(llm.generateDeploy).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ outcome: 'failed', errorClass: 'execution' });
    expect(doc.stages.deploy).toMatchObject({ status: 'failed', errorClass: 'execution', result: { status: 'failed' } });
  });

  describe('没有执行器的部署目标（cloud / git）不能假成功', () => {
    const cloud = { raw: '{}', deploy: { target: 'cloud', url: 'https://made-up.example.com', repoUrl: '', buildLog: 'ok', status: 'success' }, summary: { warnings: [] } };
    const local = { raw: '{}', deploy: { target: 'local', url: '', repoUrl: '', buildLog: '', status: 'success', port: 5173 }, summary: { warnings: [] } };
    const withCodegen = (doc: PipelineDoc) => {
      doc.stages.codegen.result = { files: [{ path: 'a', content: 'b' }], dependencies: [], runCommand: 'npm start' };
    };

    it('模型选了 cloud：不执行、不当成功；把「只支持 local」回喂后改选 local 才算数', async () => {
      const { doc, llm, deploySvc, records, run } = setup('deploy');
      withCodegen(doc);
      llm.generateDeploy.mockResolvedValueOnce(cloud).mockResolvedValueOnce(local);
      deploySvc.deploy.mockResolvedValue({ url: 'http://localhost:5173', buildLog: 'ok', status: 'success' });

      await run();

      expect(llm.generateDeploy).toHaveBeenCalledTimes(2);
      expect(llm.generateDeploy.mock.calls[1][2].feedback).toContain('只支持 local');
      expect(records.map((r) => [r.outcome, r.errorClass])).toEqual([['failed', 'invalid_output'], ['done', undefined]]);
      expect(doc.stages.deploy.result).toMatchObject({ target: 'local', url: 'http://localhost:5173' });
      expect(JSON.stringify(doc.stages.deploy)).not.toContain('made-up.example.com');
    });

    it('模型坚持选 git / cloud：阶段失败，没有任何假产出，也没有触发本地部署', async () => {
      const { doc, llm, deploySvc, run } = setup('deploy');
      withCodegen(doc);
      llm.generateDeploy.mockResolvedValue({ ...cloud, deploy: { ...cloud.deploy, target: 'git', repoUrl: 'https://github.com/made/up' } });

      await expect(run()).rejects.toThrow('当前没有执行器');

      expect(deploySvc.deploy).not.toHaveBeenCalled();
      expect(doc.stages.deploy).toMatchObject({ status: 'failed', errorClass: 'invalid_output' });
      expect(doc.stages.deploy.result).toBeUndefined();
      expect(doc.status).toBe('failed');
    });
  });
});
