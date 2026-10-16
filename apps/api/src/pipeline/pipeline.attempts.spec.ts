jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ on: jest.fn(), quit: jest.fn() })),
}));

import { LlmError, type LlmLogEntry } from '@apploom/llm';
import { PipelineService } from './pipeline.service';
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
}

const usage = { promptTokens: 100, completionTokens: 50 };
const logEntry = (label: string): LlmLogEntry => ({ label, ts: new Date().toISOString(), user: 'u', response: 'r', usage });

function setup(stage: PipelineStage = 'requirement') {
  const doc = createPipelineDoc('做一个待办应用', false);
  doc.id = 'doc1';
  doc.currentStage = stage;
  const store = new FakeStore(doc);
  const bus = { emit: jest.fn() };
  const llm = { generatePrd: jest.fn(), generateDeploy: jest.fn() };
  const records: AttemptRecord[] = [];
  const trace = { append: jest.fn(async (r: AttemptRecord) => void records.push(r)), list: jest.fn(async () => records) };
  const svc = new PipelineService(store as never, bus as never, llm as never, { deploy: jest.fn() } as never, { verify: jest.fn() } as never, trace as never);
  (svc as unknown as { queue: unknown }).queue = { add: jest.fn() };
  const run = () => (svc as unknown as { processStage(j: unknown): Promise<void> }).processStage({ data: { docId: 'doc1', stage } });
  return { doc, llm, records, run, bus };
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

  it('deploy 执行失败：errorClass=execution，保留 result 供诊断，不触发自动修复', async () => {
    const { doc, llm, records, run } = setup('deploy');
    doc.stages.codegen.result = { files: [{ path: 'a', content: 'b' }], dependencies: [], runCommand: 'npm start' };
    llm.generateDeploy.mockResolvedValue({
      raw: '{}',
      deploy: { target: 'cloud', url: '', repoUrl: '', buildLog: '', status: 'failed' },
      summary: { warnings: [] },
    });

    await expect(run()).rejects.toThrow('stage deploy failed');

    expect(llm.generateDeploy).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ outcome: 'failed', errorClass: 'execution' });
    expect(doc.stages.deploy).toMatchObject({ status: 'failed', errorClass: 'execution', result: { status: 'failed' } });
  });
});
