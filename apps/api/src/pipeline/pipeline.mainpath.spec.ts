/**
 * 五阶段主路径（不调 LLM）：用桩 Agent 跑通 创建 → 需求 → 原型 → 方案 → 代码 → 部署 → 完成，
 * 并锁定「每个阶段消费哪些上游产物」。这是阶段拓扑重构时的安全网。
 */
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ on: jest.fn(), quit: jest.fn() })),
}));

import { PipelineService } from './pipeline.service';
import { withRun } from './test-llm';
import { createPipelineDoc, PIPELINE_STAGES, type AttemptRecord, type PipelineDoc, type PipelineEvent, type PipelineStage } from './pipeline.types';

class FakeStore {
  constructor(public doc: PipelineDoc) {}
  async get() { return structuredClone(this.doc); }
  async update(_id: string, fn: (d: PipelineDoc) => void) { fn(this.doc); return this.doc; }
  async mutate<T>(_id: string, fn: (d: PipelineDoc, skip: () => void) => T) {
    const result = fn(this.doc, () => undefined);
    return { doc: structuredClone(this.doc), result };
  }
}

const OUT = {
  requirement: { prd: { overview: 'PRD-OUT' } },
  prototype: { pages: [{ id: 'home' }] },
  design: { techStack: ['react'] },
  codegen: { files: [{ path: 'package.json', content: '{}' }], dependencies: [], runCommand: 'npm run dev', notes: [] },
};

function setup(confirmEachStep: boolean) {
  const doc = createPipelineDoc('做一个计数器', confirmEachStep);
  doc.id = 'main';
  doc.currentStage = 'requirement';
  const store = new FakeStore(doc);
  const events: PipelineEvent[] = [];
  const bus = { emit: jest.fn((_id: string, e: PipelineEvent) => void events.push(e)) };
  const llm = withRun({
    generatePrd: jest.fn(async () => ({ raw: 'r', prd: OUT.requirement.prd, summary: { features: 1 } })),
    generatePrototype: jest.fn(async () => ({ raw: 'r', prototype: OUT.prototype, summary: { pages: 1 } })),
    generateDesign: jest.fn(async () => ({ raw: 'r', design: OUT.design, summary: { pages: 1 } })),
    generateCodegen: jest.fn(async () => ({ raw: 'r', codegen: OUT.codegen, summary: { files: 1 } })),
    generateDeploy: jest.fn(async () => ({ raw: 'r', deploy: { target: 'local', url: '', repoUrl: '', buildLog: '', status: 'success', port: 5173 }, summary: { warnings: [] } })),
  });
  const deploySvc = { deploy: jest.fn(async () => ({ url: 'http://localhost:5173', buildLog: 'ok', status: 'success' })) };
  const gate = { verify: jest.fn(async () => ({ passed: true, failures: [], checks: [] })) };
  const records: AttemptRecord[] = [];
  const trace = { append: jest.fn(async (r: AttemptRecord) => void records.push(r)), list: jest.fn(async () => records) };
  const jobs: Array<{ name: string; data: { docId: string; stage: PipelineStage } }> = [];
  const svc = new PipelineService(store as never, bus as never, llm as never, deploySvc as never, gate as never, trace as never);
  (svc as unknown as { queue: unknown }).queue = { add: jest.fn(async (name: string, data: never) => void jobs.push({ name, data })) };
  const processStage = (data: { docId: string; stage: PipelineStage }) =>
    (svc as unknown as { processStage(j: unknown): Promise<void> }).processStage({ data });

  /** 像 BullMQ 一样按 FIFO 消费 job；逐步确认模式下，每次挂起就点一次确认 */
  async function drain(): Promise<PipelineStage[]> {
    const order: PipelineStage[] = [];
    jobs.push({ name: 'requirement', data: { docId: 'main', stage: 'requirement' } });
    for (let guard = 0; guard < 50; guard++) {
      const job = jobs.shift();
      if (job) {
        order.push(job.data.stage);
        await processStage(job.data);
        continue;
      }
      if (doc.status === 'waiting_confirm' && doc.currentStage) {
        expect(await svc.confirm('main', doc.currentStage)).toBe(true);
        continue;
      }
      break;
    }
    return order;
  }
  return { doc, llm, deploySvc, gate, records, events, drain };
}

describe.each([
  ['自动模式', false],
  ['逐步确认模式', true],
])('五阶段主路径（%s）', (_name, confirmEachStep) => {
  it('按阶段顺序跑完，状态与交接标记正确', async () => {
    const { doc, drain, events } = setup(confirmEachStep);
    const order = await drain();

    expect(order).toEqual(PIPELINE_STAGES);
    expect(doc.status).toBe('completed');
    expect(doc.currentStage).toBeNull();
    for (const s of PIPELINE_STAGES) {
      expect(doc.stages[s].status).toBe('done');
      expect(doc.stages[s].attempts).toBe(1);
      expect(doc.handoffs[s]).toBe(true);
    }
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('每个阶段只消费它声明的上游（含 prototype → codegen 跨级边）', async () => {
    const { llm, deploySvc, gate, drain } = setup(confirmEachStep);
    await drain();

    expect(llm.generatePrd).toHaveBeenCalledWith('做一个计数器', expect.any(Function), undefined, expect.any(Function));
    expect(llm.generatePrototype).toHaveBeenCalledWith(OUT.requirement.prd, expect.any(Function), undefined, expect.any(Function));
    expect(llm.generateDesign).toHaveBeenCalledWith(OUT.requirement.prd, OUT.prototype, expect.any(Function), undefined, expect.any(Function));
    expect(llm.generateCodegen).toHaveBeenCalledWith(OUT.design, OUT.prototype, expect.any(Function), undefined, expect.any(Function));
    expect(gate.verify).toHaveBeenCalledWith('main', OUT.codegen, expect.any(Function));
    expect(llm.generateDeploy).toHaveBeenCalledWith(OUT.codegen, expect.any(Function), undefined, expect.any(Function));
    expect(deploySvc.deploy).toHaveBeenCalledWith('main', OUT.codegen, expect.any(Function), 5173);
  });

  it('每个阶段恰好一条成功的 Attempt', async () => {
    const { records, drain } = setup(confirmEachStep);
    await drain();
    expect(records.map((r) => [r.stage, r.trigger, r.outcome])).toEqual(PIPELINE_STAGES.map((s) => [s, 'initial', 'done']));
  });
});
