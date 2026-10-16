/**
 * 评测运行器：在进程内启动应用，对固定用例集跑真实流水线（到 codegen 为止，不部署），
 * 汇总通过率 / 一次通过率 / token / 耗时，并可与基线对比。会真实调用大模型、消耗 token。
 *
 * 用法（在 apps/api 下）：
 *   pnpm eval -- --label hy4-v1 [--cases counter,todo] [--baseline eval/baselines/xxx.json] [--save-baseline] [--keep]
 *
 * 环境变量：
 *   LLM_PROVIDER / *_API_KEY / *_MODEL      决定用哪个模型（沿用平台的 provider 配置）
 *   EVAL_CASE_TIMEOUT_MS      单个用例超时，默认 900000
 *   EVAL_TOTAL_TOKEN_CAP      整次评测 token 上限，超出后剩余用例跳过，默认 600000
 *   PIPELINE_TOKEN_BUDGET     单条流水线预算，评测默认 300000
 *   PIPELINE_QUEUE            评测默认用独立队列 apploom-eval，避免与开发 API 抢任务
 */
process.env.PIPELINE_QUEUE ||= 'apploom-eval';
process.env.PIPELINE_TOKEN_BUDGET ||= '300000';
process.env.LLM_TIMEOUT_MS ||= '480000';

import { NestFactory } from '@nestjs/core';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { loadProviderFromEnv } from '@apploom/llm';
import { AppModule } from '../src/app.module';
import { PipelineService } from '../src/pipeline/pipeline.service';
import { PipelineStore } from '../src/pipeline/pipeline.store';
import { TraceStore } from '../src/trace/trace.store';
import { artifactRoot } from '../src/artifacts/artifact';
import { buildCaseResult, buildReport, compareReports, formatMarkdown, skippedResult, type EvalCaseResult, type EvalReport } from '../src/eval/metrics';
import { EVAL_CASES } from './cases';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

async function main() {
  const provider = loadProviderFromEnv();
  const model = provider.model;
  console.log(`模型出口: ${new URL(provider.baseURL).host}（评测期间所有 LLM 请求只会发往该主机，且由网关统一发出）`);
  const label = arg('label') ?? model;
  const only = arg('cases')?.split(',');
  const cases = only ? EVAL_CASES.filter((c) => only.includes(c.id)) : EVAL_CASES;
  if (cases.length === 0) throw new Error(`没有匹配的用例，可选: ${EVAL_CASES.map((c) => c.id).join(', ')}`);

  const timeoutMs = num(process.env.EVAL_CASE_TIMEOUT_MS, 900_000);
  const totalCap = num(process.env.EVAL_TOTAL_TOKEN_CAP, 600_000);
  console.log(`评测开始：模型 ${model}，用例 ${cases.map((c) => c.id).join(', ')}，队列 ${process.env.PIPELINE_QUEUE}，总 token 上限 ${totalCap}`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const pipeline = app.get(PipelineService);
  const store = app.get(PipelineStore);
  const trace = app.get(TraceStore);

  const results: EvalCaseResult[] = [];
  const startedAt = new Date().toISOString();
  let spent = 0;

  for (const def of cases) {
    if (spent >= totalCap) {
      results.push(skippedResult(def, `整次评测 token 已达上限 ${totalCap}`));
      console.log(`- ${def.id}: 跳过（token 上限）`);
      continue;
    }

    const t0 = Date.now();
    const id = await pipeline.create(def.requirement, true);
    const confirmed = new Set<string>();
    console.log(`- ${def.id}: 开始 (doc ${id})`);

    for (;;) {
      const doc = await pipeline.get(id);
      if (!doc) break;
      if (doc.status === 'failed') break;
      if (doc.status === 'waiting_confirm' && doc.currentStage) {
        if (doc.currentStage === 'codegen') break;
        if (!confirmed.has(doc.currentStage)) {
          confirmed.add(doc.currentStage);
          await pipeline.confirm(id, doc.currentStage);
        }
      }
      if (Date.now() - t0 > timeoutMs) {
        console.log(`  ! 超时 ${timeoutMs / 1000}s`);
        break;
      }
      await sleep(2000);
    }

    const doc = (await pipeline.get(id))!;
    const attempts = await pipeline.listAttempts(id, undefined, false);
    const result = buildCaseResult(def, doc, attempts as never, Date.now() - t0);
    results.push(result);
    spent += result.tokens.total;
    console.log(`  ${result.passed ? '通过' : '失败'}${result.failure ? ` [${result.failure.stage}/${result.failure.errorClass}] ${result.failure.message}` : ''} | ${result.tokens.total} token | ${(result.durationMs / 1000).toFixed(1)}s | 累计 ${spent}`);

    if (!flag('keep')) {
      await store.remove(id);
      await trace.remove(id);
      await fs.rm(path.join('/tmp/apploom-gate', id), { recursive: true, force: true });
      await fs.rm(path.join(artifactRoot(), id), { recursive: true, force: true });
    }
  }

  await app.close();

  const report: EvalReport = buildReport(label, model, startedAt, results);
  const baselinePath = arg('baseline');
  const baseline = baselinePath ? (JSON.parse(await fs.readFile(baselinePath, 'utf-8')) as EvalReport) : undefined;
  const comparison = baseline ? compareReports(report, baseline) : undefined;

  const outDir = path.join(__dirname, flag('save-baseline') ? 'baselines' : 'results');
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, flag('save-baseline') ? `${label}.json` : `${startedAt.replace(/[:.]/g, '-')}-${label}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');

  console.log('\n' + formatMarkdown(report, comparison));
  console.log(`\n报告已保存: ${file}`);
  process.exit(comparison?.regressed ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
