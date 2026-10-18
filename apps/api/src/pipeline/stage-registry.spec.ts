import { STAGE_IDS, stageNode, upstreamOf } from '@apploom/shared';
import { AGENT_SPECS } from '../agent/agent-specs';
import { createStageRunner, upstreamInputs } from './stage-handlers';
import { createPipelineDoc, type LlmLogEntry, type PipelineDoc } from './pipeline.types';

describe('阶段注册表与图保持一致', () => {
  it('图里每个阶段都有 Agent 声明，且声明的 stage、温度来源一致', () => {
    expect(Object.keys(AGENT_SPECS).sort()).toEqual([...STAGE_IDS].sort());
    for (const id of STAGE_IDS) expect(AGENT_SPECS[id].stage).toBe(id);
  });

  it('每个声明的 buildUser 只读取图里声明的上游（不会偷偷依赖图外的阶段）', () => {
    for (const id of STAGE_IDS) {
      const reads = new Set<string>();
      const probe = new Proxy({}, { get: (_t, k) => { reads.add(String(k)); return {}; } });
      try { AGENT_SPECS[id].buildUser(probe); } catch { /* 渲染函数可能对假数据报错，只关心读了哪些键 */ }
      const declared = new Set(stageNode(id).inputs.map((x) => x.from));
      for (const k of reads) expect([id, declared.has(k)]).toEqual([id, true]);
    }
  });
});

describe('upstreamInputs：按图的入边装配上游', () => {
  const doc = (): PipelineDoc => {
    const d = createPipelineDoc('我的需求', false);
    for (const s of STAGE_IDS) d.stages[s].result = { from: s };
    return d;
  };
  it('首阶段取原始需求（@input），其余阶段取声明的上游产出，且不多取', () => {
    const d = doc();
    expect(upstreamInputs('requirement', d)).toEqual({ '@input': '我的需求' });
    expect(upstreamInputs('prototype', d)).toEqual({ requirement: { from: 'requirement' } });
    expect(upstreamInputs('design', d)).toEqual({ requirement: { from: 'requirement' }, prototype: { from: 'prototype' } });
    expect(upstreamInputs('codegen', d)).toEqual({ design: { from: 'design' }, prototype: { from: 'prototype' } });
    expect(upstreamInputs('deploy', d)).toEqual({ codegen: { from: 'codegen' } });
    for (const s of STAGE_IDS) expect(Object.keys(upstreamInputs(s, d)).filter((k) => k !== '@input').sort()).toEqual([...upstreamOf(s)].sort());
  });
});

describe('createStageRunner', () => {
  const deps = () => ({
    agents: { run: jest.fn(async () => ({ raw: 'r', doc: { ok: 1 }, summary: { warnings: [] } })) },
    gate: { verify: jest.fn() },
    deploy: { deploy: jest.fn() },
  });
  const ctx = (d: PipelineDoc, stage: (typeof STAGE_IDS)[number]) => ({ docId: 'x', doc: d, stage, onToken: jest.fn(), logs: [] as LlmLogEntry[], guard: jest.fn() });

  it('上游缺失：不调模型，按 invalid_input 失败并指出缺的是哪个阶段', async () => {
    const d = createPipelineDoc('x', false);
    const dp = deps();
    const r = await createStageRunner(dp as never)(ctx(d, 'design'));
    expect(r).toMatchObject({ errorClass: 'invalid_input' });
    expect(r.error).toContain('需求拆解');
    expect(dp.agents.run).not.toHaveBeenCalled();
  });

  it('没有专属后处理的阶段（需求 / 方案）走默认处理器：只调一次 Agent，原样返回', async () => {
    const d = createPipelineDoc('x', false);
    d.stages.requirement.result = { r: 1 };
    d.stages.prototype.result = { p: 1 };
    const dp = deps();
    const run = createStageRunner(dp as never);
    expect(await run(ctx(d, 'requirement'))).toMatchObject({ result: { ok: 1 }, raw: 'r' });
    expect(await run(ctx(d, 'design'))).toMatchObject({ result: { ok: 1 } });
    expect(dp.agents.run).toHaveBeenCalledTimes(2);
    expect(dp.gate.verify).not.toHaveBeenCalled();
    expect(dp.deploy.deploy).not.toHaveBeenCalled();
  });

  describe('代码生成阶段：原型 → 代码生成这条边的预算', () => {
    const codegenDoc = (prototype: unknown) => {
      const d = createPipelineDoc('x', false);
      d.stages.requirement.result = { r: 1 };
      d.stages.prototype.result = prototype;
      d.stages.design.result = { d: 1 };
      return d;
    };
    const gatedDeps = () => ({
      agents: { run: jest.fn(async () => ({ raw: 'r', doc: { files: [{ path: 'a', content: 'x' }], dependencies: [], runCommand: 'npm run dev', notes: [] }, summary: { warnings: [] } })) },
      gate: { verify: jest.fn(async () => ({ passed: true, failures: [], checks: [] })) },
      deploy: { deploy: jest.fn() },
    });

    it('典型原型在预算内：摘要里记录 L0、不提示裁剪', async () => {
      const dp = gatedDeps();
      const ctxx = ctx(codegenDoc({ appName: 'A', designStyle: 's', html: '<div>hi</div>', pages: [{ id: 'h', title: '首页' }], flows: [] }), 'codegen');
      const r = await createStageRunner(dp as never)(ctxx);
      expect(r.error).toBeUndefined();
      expect((r.summary as { prototypeTrim: { level: number; budget: number } }).prototypeTrim).toMatchObject({ level: 0, budget: 6000 });
      expect(ctxx.onToken.mock.calls.map((c) => c[0]).join('')).not.toContain('[handoff]');
    });

    it('原型元信息巨大、超出边预算：摘要记录降级等级，流里提示，且不影响阶段成功', async () => {
      const dp = gatedDeps();
      const huge = { appName: 'A', designStyle: 's', html: '<div>hi</div>', pages: Array.from({ length: 4000 }, (_, i) => ({ id: `p${i}`, title: `页面${i}` })), flows: [] };
      const ctxx = ctx(codegenDoc(huge), 'codegen');
      const r = await createStageRunner(dp as never)(ctxx);
      expect(r.error).toBeUndefined();
      const trim = (r.summary as { prototypeTrim: { level: number; overBudget: boolean; tokens: number; budget: number } }).prototypeTrim;
      expect(trim.level).toBeGreaterThanOrEqual(2);
      expect(trim.budget).toBe(6000);
      expect(ctxx.onToken.mock.calls.map((c) => c[0]).join('')).toMatch(/\[handoff\] 原型 → 代码生成：约 \d+ token，超出预算 6000，已降级到 L[23]/);
    });
  });
});
