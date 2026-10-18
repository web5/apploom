/**
 * 阶段处理器：把「一个阶段怎么执行」从 PipelineService 里分出来。
 *
 * 绝大多数阶段是同一件事——按 STAGE_GRAPH 的入边取上游产出，交给对应的 Agent。这就是默认处理器，
 * 所以加一个普通阶段只需要：图里加一项 + AGENT_SPECS 里加一份声明，这里不用动。
 * 只有带阶段特有后处理的才在 OVERRIDES 里单独写：原型存 HTML 文件、代码生成走确定性门禁、部署走真实执行器。
 */
import type { ErrorClass } from '@apploom/llm';
import { INPUT, STAGE_LABEL, edgeBudget, stageNode, upstreamOf, type StageId } from '@apploom/shared';
import type { AgentResult, UpstreamInputs } from '../agent/agent-runner';
import type { RepairContext } from '../agent/repair';
import { saveArtifact } from '../artifacts/artifact';
import type { LocalDeployService } from '../deploy/local-deploy.service';
import { formatFailures, gateMaxRepairs, gateMode, type CodegenGateService } from '../gate/codegen-gate';
import type { LlmService } from '../prd/llm.service';
import { trimPrototypeForCodegen } from '../prd/prototype-digest';
import { portOfLocalUrl, previewConfig, previewUrl } from '../preview/preview-proxy';
import type { LlmLogEntry, PipelineDoc } from './pipeline.types';

export interface StageRunResult {
  raw: string;
  result?: unknown;
  summary?: unknown;
  error?: string;
  /** error 的类别；缺省按 invalid_output（模型输出未通过解析/契约校验）处理 */
  errorClass?: ErrorClass;
  llmLogs?: LlmLogEntry[];
}

export interface StageRunContext {
  docId: string;
  doc: PipelineDoc;
  stage: StageId;
  onToken: (token: string) => void;
  /** 本次执行产生的 LLM 调用日志（处理器往里追加） */
  logs: LlmLogEntry[];
  repair?: RepairContext;
  /** 预算守卫：每次再调用模型前调用，超预算会抛错 */
  guard: () => void;
}

export interface StageRunnerDeps {
  agents: Pick<LlmService, 'run'>;
  gate: Pick<CodegenGateService, 'verify'>;
  deploy: Pick<LocalDeployService, 'deploy'>;
}

/** 各阶段必须已产出的上游（由 STAGE_GRAPH 的入边推导）；缺失时直接失败，不能把 undefined 拼进 prompt */
function missingUpstream(stage: StageId, doc: PipelineDoc): { stage: StageId; label: string } | undefined {
  const missing = upstreamOf(stage).find((u) => !doc.stages[u]?.result);
  return missing ? { stage: missing, label: STAGE_LABEL[missing] } : undefined;
}

/** 按图的入边装配该阶段的上游输入：键 = 上游阶段 id（首阶段为 '@input'） */
export function upstreamInputs(stage: StageId, doc: PipelineDoc): UpstreamInputs {
  const inputs: UpstreamInputs = {};
  for (const edge of stageNode(stage).inputs) {
    inputs[edge.from] = edge.from === INPUT ? doc.requirement : doc.stages[edge.from as StageId]?.result;
  }
  return inputs;
}

type Handler = (deps: StageRunnerDeps, ctx: StageRunContext) => Promise<StageRunResult>;

/** 多用户时把归属（租户）带给沙箱；没有归属就不传参，保持单用户调用形态不变 */
const tenantOf = (ctx: StageRunContext): [string] | [] => (ctx.doc.ownerId ? [ctx.doc.ownerId] : []);

const toResult = (r: AgentResult<unknown, unknown>, ctx: StageRunContext): StageRunResult => ({
  raw: r.raw,
  result: r.doc,
  summary: r.summary,
  error: r.error,
  errorClass: r.errorClass,
  llmLogs: ctx.logs,
});

function callAgent(deps: StageRunnerDeps, ctx: StageRunContext, repair: RepairContext | undefined = ctx.repair) {
  return deps.agents.run(ctx.stage, upstreamInputs(ctx.stage, ctx.doc), {
    onToken: ctx.onToken,
    onLog: (entry) => ctx.logs.push(entry),
    repair,
  });
}

/** 默认处理器：取上游 → 调 Agent → 原样返回 */
const agentStage: Handler = async (deps, ctx) => toResult(await callAgent(deps, ctx), ctx);

/** 原型：完整 HTML 另存为文件（doc 里仍保留一份供前端预览）；写文件失败不影响阶段结果 */
const prototypeStage: Handler = async (deps, ctx) => {
  const out = toResult(await callAgent(deps, ctx), ctx);
  const html = (out.result as { html?: unknown } | undefined)?.html;
  const htmlFile = typeof html === 'string' ? await saveArtifact(ctx.docId, 'prototype.html', html).catch(() => undefined) : undefined;
  return htmlFile && out.summary ? { ...out, summary: { ...(out.summary as object), htmlFile } } : out;
};

/**
 * 代码生成 + 确定性门禁：生成 → 校验 → 未通过则把结构化失败回喂模型重新生成（最多 N 轮）。
 * enforce 模式耗尽修复轮数后阶段失败；warn 模式只把失败记入 summary.warnings。
 */
const codegenStage: Handler = async (deps, ctx) => {
  const { docId, onToken, logs, guard, repair: userRepair } = ctx;
  const tenantArg = tenantOf(ctx);

  // 原型 → 代码生成这条边有 token 预算：超出时按 L1–L3 降级并显式告知模型。把等级记进摘要、并在流里提示，裁剪不再是看不见的
  const trim = trimPrototypeForCodegen(ctx.doc.stages.prototype.result, edgeBudget('codegen', 'prototype'));
  const prototypeTrim = { level: trim.level, tokens: trim.tokens, budget: trim.budget, overBudget: trim.overBudget };
  if (trim.trimmed) onToken(`\n[handoff] 原型 → 代码生成：约 ${trim.tokens} token，超出预算 ${trim.budget}，已降级到 L${trim.level}${trim.overBudget ? '（降到最低仍超预算）' : ''}\n`);

  let r = await callAgent(deps, ctx);
  const mode = gateMode();
  if (mode === 'off' || r.error || !r.doc) {
    const out = toResult(r, ctx);
    return out.summary ? { ...out, summary: { ...(out.summary as object), prototypeTrim } } : out;
  }

  const maxRepairs = gateMaxRepairs();
  for (let round = 0; ; round++) {
    onToken(`\n[gate] 第 ${round + 1} 轮校验…\n`);
    const report = await deps.gate.verify(docId, r.doc as never, (line) => onToken(`${line}\n`), ...tenantArg);
    const gateSummary = { mode, passed: report.passed, repairRounds: round, checks: report.checks };
    const baseSummary = (r.summary ?? {}) as { warnings?: string[] };

    if (report.passed) {
      return { raw: r.raw, result: r.doc, summary: { ...baseSummary, prototypeTrim, gate: gateSummary }, llmLogs: logs };
    }

    if (round >= maxRepairs) {
      const failureText = formatFailures(report.failures);
      if (mode === 'warn') {
        const warnings = [...(baseSummary.warnings ?? []), ...report.failures.map((f) => `[gate:${f.check}] ${f.message}`)];
        return { raw: r.raw, result: r.doc, summary: { ...baseSummary, prototypeTrim, warnings, gate: { ...gateSummary, failures: report.failures } }, llmLogs: logs };
      }
      return { raw: r.raw, error: `代码门禁未通过（已自动修复 ${round} 轮）：\n${failureText}`, errorClass: 'verification', llmLogs: logs };
    }

    onToken(`[gate] 未通过（${report.failures.length} 项），回喂模型修复…\n`);
    const feedback = [userRepair?.feedback, formatFailures(report.failures)].filter(Boolean).join('\n\n');
    guard();
    r = await callAgent(deps, ctx, { feedback, previous: r.doc, maxTokensLevel: userRepair?.maxTokensLevel });
    if (r.error || !r.doc) {
      return { raw: r.raw, error: r.error ?? '修复轮次未产出有效代码', errorClass: r.errorClass, llmLogs: logs };
    }
  }
};

/** 部署：LLM 决策部署方案 → 校验目标 → 本地真实执行，并用真实结果覆盖 LLM 的占位值 */
const deployStage: Handler = async (deps, ctx) => {
  const codegen = ctx.doc.stages.codegen.result as { files: { path: string; content: string }[]; dependencies: string[]; runCommand: string } | undefined;
  if (!codegen?.files?.length) {
    return { raw: '', error: '上游 codegen 产物为空，无法部署', errorClass: 'invalid_input' };
  }

  const tenantArg = tenantOf(ctx);
  const r = await callAgent(deps, ctx);
  if (r.error) return { raw: r.raw, error: r.error, errorClass: r.errorClass, llmLogs: ctx.logs };
  const deploy = r.doc as { target: 'local' | 'cloud' | 'git'; url: string; repoUrl: string; buildLog: string; status: 'success' | 'failed'; port?: number } | undefined;
  if (!deploy) return { raw: r.raw, error: '部署方案解析失败', llmLogs: ctx.logs };

  // 只有 local 有真实执行器。cloud / git 没有 executor：不能把 LLM 编出来的 url / repoUrl 当成部署结果（假成功），
  // 按「模型输出不合规」处理，让自动修复把约束回喂给模型重新决策
  if (deploy.target !== 'local') {
    return {
      raw: r.raw,
      error: `部署目标「${deploy.target}」当前没有执行器，只支持 local。请把 target 改为 "local" 并给出本地 dev server 端口；不要虚构 url / repoUrl。`,
      errorClass: 'invalid_output',
      llmLogs: ctx.logs,
    };
  }

  const out = await deps.deploy.deploy(ctx.docId, codegen, ctx.onToken, deploy.port, ...tenantArg);
  // 用真实结果覆盖 LLM 的占位值：port 取 dev server 实际监听的端口（反向代理按它转发）；配了预览域名时 url 换成代理地址
  const realPort = out.url ? portOfLocalUrl(out.url) : null;
  const preview = previewConfig();
  const publicUrl = out.status === 'success' && realPort && preview ? previewUrl(ctx.docId, preview) : out.url;
  const merged = { ...deploy, url: publicUrl, buildLog: out.buildLog, status: out.status, ...(realPort ? { port: realPort } : {}) };
  return {
    raw: out.buildLog,
    result: merged,
    summary: { target: 'local', url: publicUrl, status: out.status, warnings: [] },
    llmLogs: ctx.logs,
  };
};

/** 带阶段特有后处理的阶段；其余一律走 agentStage */
const OVERRIDES: Partial<Record<StageId, Handler>> = {
  prototype: prototypeStage,
  codegen: codegenStage,
  deploy: deployStage,
};

/** 创建「执行单个阶段」的函数：先检查上游是否齐全，再交给该阶段的处理器 */
export function createStageRunner(deps: StageRunnerDeps): (ctx: StageRunContext) => Promise<StageRunResult> {
  return async (ctx) => {
    const missing = missingUpstream(ctx.stage, ctx.doc);
    if (missing) {
      return { raw: '', error: `上游「${missing.label}」产物缺失，无法继续（请先完成该阶段）`, errorClass: 'invalid_input', llmLogs: ctx.logs };
    }
    return (OVERRIDES[ctx.stage] ?? agentStage)(deps, ctx);
  };
}
