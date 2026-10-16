/**
 * 评测指标：把一条流水线的最终文档 + 执行记录（Attempt）汇总成可比较的数字。
 * 纯函数、无 IO，便于单测；运行器在 apps/api/eval/run-eval.ts。
 */
import type { AttemptRecord, PipelineDoc, PipelineStage } from '../pipeline/pipeline.types';

const STAGES: PipelineStage[] = ['requirement', 'prototype', 'design', 'codegen', 'deploy'];

export interface EvalCaseDef {
  id: string;
  title: string;
  requirement: string;
}

interface GateSummary {
  passed: boolean;
  repairRounds: number;
  checks?: Array<{ name: string; ok: boolean }>;
}

export interface EvalCaseResult {
  id: string;
  title: string;
  /** 跑到 codegen 完成且（若有校验）门禁通过 = 本用例通过 */
  passed: boolean;
  reachedCodegen: boolean;
  stageStatus: Record<string, string>;
  failure?: { stage: string; errorClass?: string; message: string };
  gate?: { passed: boolean; repairRounds: number; checks: Array<{ name: string; ok: boolean }> };
  /** 模型输出不合规后的自动回喂次数 */
  autoRepairs: number;
  /** 一次生成即通过（无门禁修复、无自动修复） */
  firstTry: boolean;
  llmCalls: number;
  tokens: { prompt: number; completion: number; total: number; estimated: boolean };
  durationMs: number;
  stageDurationsMs: Record<string, number>;
  files?: number;
  skipped?: string;
}

export interface EvalTotals {
  cases: number;
  passed: number;
  passRate: number;
  firstTryRate: number;
  avgTokens: number;
  avgDurationMs: number;
  avgAutoRepairs: number;
  avgGateRepairRounds: number;
}

export interface EvalReport {
  label: string;
  model: string;
  startedAt: string;
  cases: EvalCaseResult[];
  totals: EvalTotals;
}

export function buildCaseResult(def: EvalCaseDef, doc: PipelineDoc, attempts: AttemptRecord[], durationMs: number): EvalCaseResult {
  const stageStatus = Object.fromEntries(STAGES.map((s) => [s, doc.stages[s].status]));
  const codegen = doc.stages.codegen;
  const reachedCodegen = codegen.status === 'done' || codegen.status === 'waiting_confirm';

  const gate = (codegen.summary as { gate?: GateSummary } | undefined)?.gate;
  const failedStage = STAGES.find((s) => doc.stages[s].status === 'failed');

  const tokens = attempts.reduce(
    (acc, a) => {
      acc.prompt += a.usage.promptTokens;
      acc.completion += a.usage.completionTokens;
      acc.estimated ||= !!a.usage.estimated;
      return acc;
    },
    { prompt: 0, completion: 0, total: 0, estimated: false },
  );
  tokens.total = tokens.prompt + tokens.completion;

  const stageDurationsMs: Record<string, number> = {};
  for (const a of attempts) stageDurationsMs[a.stage] = (stageDurationsMs[a.stage] ?? 0) + a.durationMs;

  const autoRepairs = attempts.filter((a) => a.trigger === 'auto-repair').length;
  const gateRounds = gate?.repairRounds ?? 0;
  const gateOk = gate ? gate.passed : true;
  const files = (codegen.result as { files?: unknown[] } | undefined)?.files?.length;

  return {
    id: def.id,
    title: def.title,
    passed: reachedCodegen && gateOk,
    reachedCodegen,
    stageStatus,
    failure: failedStage
      ? { stage: failedStage, errorClass: doc.stages[failedStage].errorClass, message: (doc.stages[failedStage].error ?? '').split('\n')[0].slice(0, 200) }
      : undefined,
    gate: gate ? { passed: gate.passed, repairRounds: gate.repairRounds, checks: (gate.checks ?? []).map((c) => ({ name: c.name, ok: c.ok })) } : undefined,
    autoRepairs,
    firstTry: reachedCodegen && gateOk && gateRounds === 0 && autoRepairs === 0,
    llmCalls: attempts.reduce((n, a) => n + a.llmCalls, 0),
    tokens,
    durationMs,
    stageDurationsMs,
    files,
  };
}

export function skippedResult(def: EvalCaseDef, reason: string): EvalCaseResult {
  return {
    id: def.id,
    title: def.title,
    passed: false,
    reachedCodegen: false,
    stageStatus: {},
    autoRepairs: 0,
    firstTry: false,
    llmCalls: 0,
    tokens: { prompt: 0, completion: 0, total: 0, estimated: false },
    durationMs: 0,
    stageDurationsMs: {},
    skipped: reason,
  };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** 汇总只统计实际执行过的用例（跳过的不计入分母） */
export function summarize(cases: EvalCaseResult[]): EvalTotals {
  const ran = cases.filter((c) => !c.skipped);
  return {
    cases: ran.length,
    passed: ran.filter((c) => c.passed).length,
    passRate: ran.length ? ran.filter((c) => c.passed).length / ran.length : 0,
    firstTryRate: ran.length ? ran.filter((c) => c.firstTry).length / ran.length : 0,
    avgTokens: Math.round(avg(ran.map((c) => c.tokens.total))),
    avgDurationMs: Math.round(avg(ran.map((c) => c.durationMs))),
    avgAutoRepairs: Number(avg(ran.map((c) => c.autoRepairs)).toFixed(2)),
    avgGateRepairRounds: Number(avg(ran.map((c) => c.gate?.repairRounds ?? 0)).toFixed(2)),
  };
}

export function buildReport(label: string, model: string, startedAt: string, cases: EvalCaseResult[]): EvalReport {
  return { label, model, startedAt, cases, totals: summarize(cases) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const signed = (n: number, unit = '') => `${n > 0 ? '+' : ''}${Number.isInteger(n) ? n : n.toFixed(2)}${unit}`;

export interface Comparison {
  lines: string[];
  /** 通过率下降，或原本通过的用例现在失败 */
  regressed: boolean;
}

/** 与基线对比：只对两边都实际执行过的用例做逐条比较 */
export function compareReports(current: EvalReport, baseline: EvalReport): Comparison {
  const lines: string[] = [];
  const c = current.totals;
  const b = baseline.totals;
  lines.push(`通过率 ${pct(b.passRate)} → ${pct(c.passRate)}（${signed(Math.round((c.passRate - b.passRate) * 100), 'pt')}）`);
  lines.push(`一次通过率 ${pct(b.firstTryRate)} → ${pct(c.firstTryRate)}`);
  lines.push(`平均 token ${b.avgTokens} → ${c.avgTokens}（${b.avgTokens ? signed(Math.round(((c.avgTokens - b.avgTokens) / b.avgTokens) * 100), '%') : 'n/a'}）`);
  lines.push(`平均耗时 ${sec(b.avgDurationMs)} → ${sec(c.avgDurationMs)}`);
  lines.push(`平均自动修复 ${b.avgAutoRepairs} → ${c.avgAutoRepairs}；平均门禁修复轮数 ${b.avgGateRepairRounds} → ${c.avgGateRepairRounds}`);

  let regressed = c.passRate < b.passRate;
  for (const cur of current.cases) {
    const base = baseline.cases.find((x) => x.id === cur.id);
    if (!base || cur.skipped || base.skipped) continue;
    if (base.passed && !cur.passed) {
      regressed = true;
      lines.push(`⚠ 回退：${cur.id} 原本通过，现在失败（${cur.failure?.errorClass ?? '未知'}: ${cur.failure?.message ?? ''}）`);
    } else if (!base.passed && cur.passed) {
      lines.push(`✓ 改善：${cur.id} 原本失败，现在通过`);
    }
  }
  return { lines, regressed };
}

export function formatMarkdown(report: EvalReport, comparison?: Comparison): string {
  const rows = report.cases.map((c) => {
    if (c.skipped) return `| ${c.id} | 跳过 | - | - | - | - | ${c.skipped} |`;
    const gate = c.gate ? `${c.gate.passed ? '通过' : '未通过'}（修复 ${c.gate.repairRounds} 轮）` : '无需校验';
    const note = c.failure ? `${c.failure.stage}/${c.failure.errorClass ?? '?'}: ${c.failure.message}` : c.firstTry ? '一次通过' : '';
    return `| ${c.id} | ${c.passed ? '✅' : '❌'} | ${gate} | ${c.autoRepairs} | ${c.tokens.total}${c.tokens.estimated ? '(估)' : ''} | ${sec(c.durationMs)} | ${note} |`;
  });
  const t = report.totals;
  const out = [
    `## 评测报告：${report.label}（模型 ${report.model}）`,
    '',
    '| 用例 | 结果 | 门禁 | 自动修复 | token | 耗时 | 备注 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `通过 ${t.passed}/${t.cases}（${pct(t.passRate)}），一次通过 ${pct(t.firstTryRate)}，平均 ${t.avgTokens} token / ${sec(t.avgDurationMs)}`,
  ];
  if (comparison) out.push('', '### 与基线对比', ...comparison.lines.map((l) => `- ${l}`), comparison.regressed ? '\n**结论：存在回退**' : '\n**结论：未发现回退**');
  return out.join('\n');
}
