/**
 * AgentRunner：一次阶段 Agent 调用——拼 prompt → 调模型 → 解析校验 → 失败归类/恢复。
 *
 * 五个阶段的差别只有 schema、prompt、上游怎么渲染、产出怎么摘要，这些都在 AgentSpec 里声明；
 * 温度取自 STAGE_GRAPH（单一事实源）。模型客户端可注入（chatFn），测试里换成脚本化的假模型即可，不碰网络。
 */
import { chat, loadProviderFromEnv, type ChatResult, type ErrorClass, type LlmLogEntry } from '@apploom/llm';
import { stageNode, type StageId } from '@apploom/shared';
import type { ZodType } from 'zod';
import { parseFailure, parseOutput, type Parsed } from './output';
import { buildRepairSuffix, maxTokensFor, type RepairContext } from './repair';

export type ChatFn = (config: ReturnType<typeof loadProviderFromEnv>, options: Parameters<typeof chat>[1]) => Promise<ChatResult>;

/** 解析失败后「带错误反馈重问一次」的策略（目前只有原型阶段需要：HTML 里的非法反斜杠最容易让整份 JSON 作废） */
export interface ReaskPolicy {
  /** 把解析错误包装成给用户 / 模型看的文案 */
  wrapError(parseError: string): string;
  /** 重问时追加给模型的反馈 */
  feedback(wrappedError: string): string;
  /** 重问时的输出上限（固定值，不随截断自愈放大） */
  maxTokens: number;
}

/** 一个阶段消费的上游，键是 STAGE_GRAPH 入边的 from（上游阶段 id，或首阶段的 '@input'），值是该上游的产出 */
export type UpstreamInputs = Partial<Record<string, unknown>>;

export interface AgentSpec<TDoc, TSummary extends { warnings: string[] }> {
  stage: StageId;
  /** 日志 / trace 里的调用标识（前端调试面板按它展示） */
  label: string;
  system: string;
  schema: ZodType<TDoc>;
  /** 给模型的 JSON Schema 及其名字（由 Zod 生成） */
  jsonSchema: Record<string, unknown>;
  jsonSchemaName: string;
  /** 默认输出上限；缺省 = 交给服务商默认值 */
  maxTokens?: number;
  /** 渲染 user prompt 主体（不含修复反馈，runner 负责追加） */
  buildUser(inputs: UpstreamInputs): string;
  /** 产出摘要与质量告警 */
  summarize(doc: TDoc): TSummary;
  reask?: ReaskPolicy;
}

export interface AgentCtx {
  onToken: (token: string) => void;
  onLog?: (entry: LlmLogEntry) => void;
  repair?: RepairContext;
  /** 默认走真实网关 */
  chatFn?: ChatFn;
}

export interface AgentResult<TDoc, TSummary> {
  raw: string;
  doc?: TDoc;
  error?: string;
  /** error 的类别：被 max_tokens 截断时为 'truncated'，缺省按 invalid_output 处理 */
  errorClass?: ErrorClass;
  summary?: TSummary;
}

const LOCAL_REPAIR_WARNING = '已通过本地 JSON 修复恢复（原始输出含反斜杠非法转义，已自动修正）';

export async function runAgent<TDoc, TSummary extends { warnings: string[] }>(
  spec: AgentSpec<TDoc, TSummary>,
  inputs: UpstreamInputs,
  ctx: AgentCtx,
): Promise<AgentResult<TDoc, TSummary>> {
  const provider = loadProviderFromEnv();
  const chatFn = ctx.chatFn ?? (chat as ChatFn);
  const { temperature } = stageNode(spec.stage);
  const baseUser = spec.buildUser(inputs);

  const call = (label: string, user: string, maxTokens: number | undefined) =>
    chatFn(provider, {
      label,
      onLog: ctx.onLog,
      system: spec.system,
      user,
      temperature,
      maxTokens,
      jsonSchema: { name: spec.jsonSchemaName, schema: spec.jsonSchema },
      stream: true,
      onToken: ctx.onToken,
    });

  const succeed = (parsed: Extract<Parsed<TDoc>, { ok: true }>, extraWarnings: string[]): AgentResult<TDoc, TSummary> => {
    const summary = spec.summarize(parsed.doc);
    summary.warnings = [...extraWarnings, ...summary.warnings];
    return { raw: parsed.raw, doc: parsed.doc, summary };
  };

  const result = await call(spec.label, baseUser + (ctx.repair ? buildRepairSuffix(ctx.repair) : ''), maxTokensFor(spec.maxTokens, ctx.repair));
  const raw = result.content;
  const parsed = parseOutput(raw, spec.schema);
  if (parsed.ok) {
    if (parsed.repaired) console.warn(`[${spec.label}] 通过本地 JSON 修复（反斜杠非法转义）恢复成功`);
    return succeed(parsed, parsed.repaired ? [LOCAL_REPAIR_WARNING] : []);
  }

  const msg = spec.reask ? spec.reask.wrapError(parsed.error) : parsed.error;
  // 被 max_tokens 截断：重问只会再被截断，交给流水线放大上限后重跑
  if (result.finishReason === 'length') return parseFailure(raw, result.finishReason, msg);
  // 已经处在修复 / 重试之中就不再重问，避免无限套娃
  if (!spec.reask || ctx.repair) return parseFailure(raw, result.finishReason, msg);

  console.warn(`[${spec.label}] JSON 解析失败，让 LLM 重新生成 1 次：${msg}`);
  const retryRepair: RepairContext = { feedback: spec.reask.feedback(msg), previous: raw, previousError: msg };
  const retry = await call(`${spec.label}-retry`, baseUser + buildRepairSuffix(retryRepair), spec.reask.maxTokens);
  const reparsed = parseOutput(retry.content, spec.schema);
  if (reparsed.ok) {
    return succeed(reparsed, [reparsed.repaired ? '已通过 LLM 重新生成 + 本地 JSON 修复恢复' : '已通过 LLM 重新生成成功（上次 JSON 解析失败）']);
  }
  const retryFailure = parseFailure(retry.content, retry.finishReason, 'JSON 解析失败（LLM 重新生成后仍无法解析）');
  // 重问本身也被截断时保留这个类别，让流水线能据此放大上限
  if (retryFailure.errorClass === 'truncated') return retryFailure;
  return { raw, error: `JSON 解析失败（重试后仍失败）：${msg}` };
}
