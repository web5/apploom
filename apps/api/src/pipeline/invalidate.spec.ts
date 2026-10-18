import { fingerprint } from './fingerprint';
import { currentUpstreamFingerprints, findOutdatedStages, isStageStillValid } from './invalidate';
import { createPipelineDoc, PIPELINE_STAGES, type PipelineDoc, type PipelineStage } from './pipeline.types';
import { applyStageStart, applyStageSuccess, applyRepair, applyRevalidate } from './transitions';

const OUT: Record<PipelineStage, unknown> = {
  requirement: { prd: 1 },
  prototype: { html: '<p>v1</p>' },
  design: { stack: ['react'] },
  codegen: { files: ['a'] },
  deploy: { url: 'http://localhost:5173' },
};

/** 按真实流程把五个阶段逐个跑成功，记录血统 */
function fullyRun(outputs: Record<PipelineStage, unknown> = OUT): PipelineDoc {
  const d = createPipelineDoc('我的需求', false);
  d.id = 'x';
  for (const s of PIPELINE_STAGES) {
    const attempt = applyStageStart(d, s);
    const consumed = currentUpstreamFingerprints(d, s);
    applyStageSuccess(d, s, attempt, { result: outputs[s], raw: 'r' }, [], consumed);
    d.handoffs[s] = true;
  }
  d.status = 'completed';
  return d;
}

describe('血统记录（v1a）', () => {
  it('成功时记下产物指纹，以及当时依据的每个上游的指纹（首阶段是需求原文）', () => {
    const d = fullyRun();
    expect(d.stages.requirement.fingerprint).toBe(fingerprint(OUT.requirement));
    expect(d.stages.requirement.consumed).toEqual({ '@input': fingerprint('我的需求') });
    expect(d.stages.prototype.consumed).toEqual({ requirement: fingerprint(OUT.requirement) });
    expect(d.stages.design.consumed).toEqual({ requirement: fingerprint(OUT.requirement), prototype: fingerprint(OUT.prototype) });
    // 跨级边：codegen 同时依据 design 与 prototype
    expect(d.stages.codegen.consumed).toEqual({ design: fingerprint(OUT.design), prototype: fingerprint(OUT.prototype) });
    expect(d.stages.deploy.consumed).toEqual({ codegen: fingerprint(OUT.codegen) });
  });

  it('不传 consumed 时不写血统（老调用方不受影响）', () => {
    const d = createPipelineDoc('x', false);
    const a = applyStageStart(d, 'requirement');
    applyStageSuccess(d, 'requirement', a, { result: { ok: 1 } }, []);
    expect(d.stages.requirement.consumed).toBeUndefined();
    expect(d.stages.requirement.fingerprint).toBe(fingerprint({ ok: 1 }));
  });
});

describe('isStageStillValid', () => {
  it('刚跑完的整条流水线：每个阶段都有效', () => {
    const d = fullyRun();
    expect(PIPELINE_STAGES.map((s) => isStageStillValid(d, s))).toEqual([true, true, true, true, true]);
    expect(findOutdatedStages(d)).toEqual([]);
  });

  it('上游产出变了：直接依赖它的阶段失效；不依赖它的阶段不受影响', () => {
    const d = fullyRun();
    d.stages.prototype.result = { html: '<p>v2</p>' }; // 原型被改（只改结果，模拟上游新版本）
    d.stages.prototype.fingerprint = fingerprint(d.stages.prototype.result);
    expect(isStageStillValid(d, 'prototype')).toBe(true); // 它依据的 requirement 没变
    expect(isStageStillValid(d, 'requirement')).toBe(true);
    expect(isStageStillValid(d, 'design')).toBe(false); // 依据 prototype
    expect(isStageStillValid(d, 'codegen')).toBe(false); // 跨级边也依据 prototype
    expect(isStageStillValid(d, 'deploy')).toBe(true); // 只依据 codegen，codegen 产出本身没变
  });

  it('需求原文改了：首阶段失效', () => {
    const d = fullyRun();
    d.requirement = '换一个需求';
    expect(isStageStillValid(d, 'requirement')).toBe(false);
  });

  it('上游自己还不是 done（过期 / 执行中）：下游即使指纹相同也不能算有效', () => {
    const d = fullyRun();
    d.stages.design.status = 'stale';
    expect(isStageStillValid(d, 'codegen')).toBe(false);
    d.stages.design.status = 'running';
    expect(isStageStillValid(d, 'codegen')).toBe(false);
  });

  it('老数据没有指纹 / 血统：无法证明有效，保守地判为无效', () => {
    const d = fullyRun();
    d.stages.design.consumed = undefined;
    expect(isStageStillValid(d, 'design')).toBe(false);
    d.stages.codegen.fingerprint = undefined;
    expect(isStageStillValid(d, 'codegen')).toBe(false);
  });

  it('没有产物的阶段无效', () => {
    const d = createPipelineDoc('x', false);
    expect(PIPELINE_STAGES.some((s) => isStageStillValid(d, s))).toBe(false);
  });

  it('指纹与字段顺序无关：上游产物只是 key 顺序变了，不算变', () => {
    const d = fullyRun({ ...OUT, design: { stack: ['react'], a: 1, b: 2 } as unknown });
    d.stages.design.result = { b: 2, a: 1, stack: ['react'] };
    expect(isStageStillValid(d, 'codegen')).toBe(true);
  });
});

describe('repair 的 keepStale 选项与 revalidate', () => {
  it('keepStale=false（原有行为）：下游产物清空、回到 pending', () => {
    const d = fullyRun();
    applyRepair(d, 'prototype', '换风格');
    expect(PIPELINE_STAGES.map((s) => d.stages[s].status)).toEqual(['done', 'pending', 'pending', 'pending', 'pending']);
    expect(d.stages.design.result).toBeUndefined();
  });

  it('keepStale=true：下游保留旧产物并标记 stale；被修复的阶段本身照旧重置；失败的下游照旧重置为 pending', () => {
    const d = fullyRun();
    d.stages.deploy.status = 'failed';
    d.stages.deploy.result = { half: 1 };
    applyRepair(d, 'prototype', '换风格', { keepStale: true });
    expect(PIPELINE_STAGES.map((s) => d.stages[s].status)).toEqual(['done', 'pending', 'stale', 'stale', 'pending']);
    expect(d.stages.design.result).toEqual(OUT.design); // 旧产物还在，可对照
    expect(d.stages.design.fingerprint).toBeDefined();
    expect(d.stages.prototype.result).toBeUndefined();
    expect(PIPELINE_STAGES.map((s) => d.handoffs[s])).toEqual([true, false, false, false, false]);
  });

  it('applyRevalidate：只允许 stale → done，其它状态拒绝且不改文档', () => {
    const d = fullyRun();
    applyRepair(d, 'prototype', 'x', { keepStale: true });
    expect(applyRevalidate(d, 'design')).toBe(true);
    expect(d.stages.design.status).toBe('done');
    const before = structuredClone(d);
    expect(applyRevalidate(d, 'design')).toBe(false); // 已经是 done
    expect(applyRevalidate(d, 'prototype')).toBe(false); // pending
    expect(d).toEqual(before);
  });

  it('过期阶段真的要重跑时：旧产物归档进 history，清掉结果与血统，不会被下游当成有效上游', () => {
    const d = fullyRun();
    applyRepair(d, 'prototype', 'x', { keepStale: true });
    const attemptsBefore = d.stages.design.attempts;
    const attempt = applyStageStart(d, 'design');
    expect(attempt).toBe(attemptsBefore + 1);
    expect(d.stages.design).toMatchObject({ status: 'running', result: undefined, fingerprint: undefined, consumed: undefined });
    expect(d.stages.design.history).toEqual([{ result: OUT.design, error: undefined }]);
  });
});
