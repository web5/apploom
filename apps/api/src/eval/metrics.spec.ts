import { buildCaseResult, buildReport, compareReports, formatMarkdown, skippedResult, summarize, type EvalCaseDef } from './metrics';
import { createPipelineDoc, type AttemptRecord, type PipelineDoc } from '../pipeline/pipeline.types';

const def: EvalCaseDef = { id: 'counter', title: '计数器', requirement: 'x' };

function attempt(over: Partial<AttemptRecord>): AttemptRecord {
  return {
    id: 'a', docId: 'd', stage: 'codegen', n: 1, trigger: 'initial', startedAt: '', finishedAt: '', durationMs: 1000,
    outcome: 'done', usage: { promptTokens: 100, completionTokens: 50 }, llmCalls: 1, llmLogs: [], ...over,
  };
}

function docWith(codegenSummary: unknown, codegenStatus: 'done' | 'failed' = 'done', errorClass?: string): PipelineDoc {
  const d = createPipelineDoc('x', true);
  for (const s of ['requirement', 'prototype', 'design'] as const) d.stages[s].status = 'done';
  d.stages.codegen.status = codegenStatus;
  d.stages.codegen.summary = codegenSummary;
  d.stages.codegen.result = { files: [1, 2, 3] };
  if (codegenStatus === 'failed') { d.stages.codegen.error = '代码门禁未通过\n详情'; d.stages.codegen.errorClass = errorClass as never; }
  return d;
}

describe('buildCaseResult', () => {
  it('一次通过：门禁 0 轮修复、无自动修复', () => {
    const r = buildCaseResult(def, docWith({ gate: { passed: true, repairRounds: 0, checks: [{ name: 'build', ok: true, ms: 5 }] } }), [attempt({ stage: 'requirement' }), attempt({})], 5000);
    expect(r).toMatchObject({ passed: true, firstTry: true, reachedCodegen: true, autoRepairs: 0, llmCalls: 2, files: 3, durationMs: 5000 });
    expect(r.tokens).toEqual({ prompt: 200, completion: 100, total: 300, estimated: false });
    expect(r.stageDurationsMs).toEqual({ requirement: 1000, codegen: 1000 });
    expect(r.gate?.checks).toEqual([{ name: 'build', ok: true }]);
  });

  it('门禁修复过一轮：通过但不算一次通过', () => {
    const r = buildCaseResult(def, docWith({ gate: { passed: true, repairRounds: 1 } }), [attempt({})], 1);
    expect(r).toMatchObject({ passed: true, firstTry: false });
  });

  it('自动修复过：计数且不算一次通过；估算用量会标记', () => {
    const r = buildCaseResult(def, docWith({}), [attempt({ usage: { promptTokens: 1, completionTokens: 1, estimated: true } }), attempt({ trigger: 'auto-repair' })], 1);
    expect(r).toMatchObject({ passed: true, firstTry: false, autoRepairs: 1 });
    expect(r.tokens.estimated).toBe(true);
  });

  it('门禁未通过 / 阶段失败：不通过，并记录失败阶段与类别', () => {
    const r = buildCaseResult(def, docWith(undefined, 'failed', 'verification'), [attempt({ outcome: 'failed' })], 1);
    expect(r).toMatchObject({ passed: false, reachedCodegen: false, failure: { stage: 'codegen', errorClass: 'verification', message: '代码门禁未通过' } });
  });

  it('静态产物（无 gate 摘要）视为无需校验，到达 codegen 即通过', () => {
    expect(buildCaseResult(def, docWith({ files: 2 }), [attempt({})], 1).passed).toBe(true);
  });
});

describe('summarize / compare', () => {
  const pass = (id: string, tokens: number, extra: object = {}) => ({ ...buildCaseResult({ ...def, id }, docWith({ gate: { passed: true, repairRounds: 0 } }), [attempt({ usage: { promptTokens: tokens, completionTokens: 0 } })], 1000), ...extra });
  const fail = (id: string) => buildCaseResult({ ...def, id }, docWith(undefined, 'failed', 'verification'), [attempt({ outcome: 'failed' })], 1000);

  it('跳过的用例不计入分母', () => {
    const t = summarize([pass('a', 100), fail('b'), skippedResult({ ...def, id: 'c' }, '预算用尽')]);
    expect(t).toMatchObject({ cases: 2, passed: 1, passRate: 0.5, avgTokens: 125 }); // (100 + 150) / 2，跳过的用例 0 token 不参与平均
  });

  it('对比基线：通过率下降或原通过用例失败 = 回退', () => {
    const base = buildReport('base', 'm', '', [pass('a', 100), pass('b', 100)]);
    const cur = buildReport('cur', 'm', '', [pass('a', 100), fail('b')]);
    const cmp = compareReports(cur, base);
    expect(cmp.regressed).toBe(true);
    expect(cmp.lines.join('\n')).toMatch(/回退：b 原本通过，现在失败/);
  });

  it('对比基线：改善且无回退', () => {
    const base = buildReport('base', 'm', '', [pass('a', 200), fail('b')]);
    const cur = buildReport('cur', 'm', '', [pass('a', 100), pass('b', 100)]);
    const cmp = compareReports(cur, base);
    expect(cmp.regressed).toBe(false);
    expect(cmp.lines.join('\n')).toMatch(/改善：b/);
    expect(cmp.lines[2]).toContain('-');
  });

  it('markdown 报告包含用例行与结论', () => {
    const base = buildReport('base', 'm', '', [pass('a', 100)]);
    const md = formatMarkdown(buildReport('cur', 'hy4', '', [pass('a', 100), fail('b')]), compareReports(buildReport('cur', 'hy4', '', [pass('a', 100), fail('b')]), base));
    expect(md).toContain('| a | ✅ |');
    expect(md).toContain('| b | ❌ |');
    expect(md).toContain('存在回退');
  });
});

describe('环境原因失败 = 无法判定', () => {
  const base = (id: string) => buildCaseResult({ ...def, id }, docWith({ gate: { passed: true, repairRounds: 0 } }), [attempt({})], 1000);
  const infra = (id: string, cls: string) => buildCaseResult({ ...def, id }, docWith(undefined, 'failed', cls), [attempt({ outcome: 'failed' })], 1000);

  it.each(['budget', 'permission', 'transient', 'not_found'])('%s 类失败标记为 inconclusive，且不算通过', (cls) => {
    expect(infra('x', cls)).toMatchObject({ passed: false, inconclusive: true });
  });

  it.each(['verification', 'invalid_output', 'execution', 'unknown'])('%s 类失败是代码/模型层面的真实失败，不是 inconclusive', (cls) => {
    expect(infra('x', cls).inconclusive).toBe(false);
  });

  it('汇总排除无法判定的用例，对比时不算回退，并提示重跑', () => {
    const baseline = buildReport('b', 'm', '', [base('a'), base('b')]);
    const current = buildReport('c', 'm', '', [base('a'), infra('b', 'budget')]);
    expect(current.totals).toMatchObject({ cases: 1, passed: 1, passRate: 1, inconclusive: 1 });
    const cmp = compareReports(current, baseline);
    expect(cmp.regressed).toBe(false);
    expect(cmp.lines.join('\n')).toMatch(/无法判定：b 因环境原因失败（budget）/);
    expect(formatMarkdown(current, cmp)).toMatch(/无法判定.*环境原因 budget/);
  });
});
