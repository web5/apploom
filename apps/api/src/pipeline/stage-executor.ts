/**
 * StageExecutor：执行一个阶段并为每次执行记录 Attempt（trace）。
 *
 * 只负责「跑一次阶段并按错误类别决定恢复动作」，不碰文档状态与队列——那是 PipelineService 的事。
 *   - 模型输出不合规（invalid_output）→ 自动回喂校验错误再生成
 *   - 被 token 上限截断（truncated）→ 放大输出上限并要求精简后重新生成
 *   - 其余类别（permission / verification / execution / transient 重试耗尽 …）直接失败，不盲目重试
 * 每次执行前后都过预算守卫：基线 = 本流水线此前所有执行的用量。
 */
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { classifyError } from '@apploom/llm';
import type { RepairContext } from '../agent/repair';
import { assertWithinBudget, sumUsage, totalTokens } from '../trace/budget';
import { TraceStore, summarizeUsage } from '../trace/trace.store';
import type { PipelineBus } from './pipeline.bus';
import { PIPELINE_STAGES, type AttemptRecord, type AttemptTrigger, type LlmLogEntry, type PipelineDoc, type PipelineStage } from './pipeline.types';
import type { StageRunContext, StageRunResult } from './stage-handlers';
import type { StageFailureInfo } from './transitions';

export interface StageOutcome {
  result?: StageRunResult;
  failure?: StageFailureInfo;
  logs: LlmLogEntry[];
}

/** 模型输出不合规（含被 token 上限截断）时，自动回喂错误重新生成的最大轮数（STAGE_AUTO_REPAIRS，默认 1） */
export function stageAutoRepairs(): number {
  const n = Number(process.env.STAGE_AUTO_REPAIRS ?? 1);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

export class StageExecutor {
  private readonly logger = new Logger(StageExecutor.name);

  constructor(
    private readonly bus: Pick<PipelineBus, 'emit'>,
    private readonly trace: Pick<TraceStore, 'append' | 'list'>,
    private readonly runStage: (ctx: StageRunContext) => Promise<StageRunResult>,
  ) {}

  /** 构造带反馈的重生成上下文（有 feedback 或上次失败时） */
  buildRepair(stage: PipelineStage, doc: PipelineDoc): RepairContext | undefined {
    const state = doc.stages[stage];
    if (!state.feedback) return undefined;
    const lastHistory = state.history?.[state.history.length - 1];
    return {
      feedback: state.feedback,
      previous: lastHistory?.result ?? state.result,
      previousError: lastHistory?.error,
    };
  }

  /**
   * 执行一个阶段并为每次执行记录 Attempt（trace）。
   * 按错误类别决定恢复动作：模型输出不合规（invalid_output）自动回喂校验错误再生成，
   * 其余类别（permission / verification / execution / transient 重试耗尽 …）直接失败，不盲目重试。
   */
  async execute(docId: string, stage: PipelineStage, doc: PipelineDoc, firstN: number): Promise<StageOutcome> {
    const userRepair = this.buildRepair(stage, doc);
    const maxAuto = stageAutoRepairs();
    const onToken = (token: string) => this.bus.emit(docId, { type: 'token', stage, token });
    let repair = userRepair;
    let truncations = 0;
    let trigger: AttemptTrigger = userRepair ? 'repair' : firstN > 1 ? 'retry' : 'initial';

    for (let auto = 0; ; auto++) {
      const logs: LlmLogEntry[] = [];
      const started = Date.now();
      let result: StageRunResult | undefined;
      let failure: StageFailureInfo | undefined;

      // 预算守卫：基线 = 本流水线此前所有执行的用量；每次调用模型前再叠加本次已产生的用量
      const baseline = totalTokens(await this.priorUsage(docId, doc));
      const guard = () => assertWithinBudget(baseline + totalTokens(summarizeUsage(logs)));

      try {
        guard();
        result = await this.runStage({ docId, doc, stage, onToken, logs, repair, guard });
        if (result.error) {
          failure = { message: result.error, errorClass: result.errorClass ?? 'invalid_output' };
        } else if ((result.result as { status?: string } | undefined)?.status === 'failed') {
          // 阶段「产出失败但有 raw/result」（如 deploy install 失败）
          failure = {
            message: result.raw?.split('\n').filter(Boolean).slice(-1)[0] ?? '部署失败',
            errorClass: 'execution',
            keepResult: true,
          };
        }
      } catch (e) {
        failure = { message: (e as Error).message, errorClass: classifyError(e) };
      }

      const record: AttemptRecord = {
        id: randomUUID(),
        docId,
        stage,
        n: firstN + auto,
        trigger,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        outcome: failure ? 'failed' : 'done',
        errorClass: failure?.errorClass,
        error: failure?.message,
        feedback: repair?.feedback,
        usage: summarizeUsage(logs),
        llmCalls: logs.length,
        llmLogs: logs,
      };
      await this.trace.append(record);

      if (failure?.errorClass === 'truncated' && auto < maxAuto) {
        // 截断：原样重试必然再被截断。放大输出上限并要求精简；被截断的半截输出不回喂（既无法解析又白占 token）
        truncations++;
        onToken(`\n[auto-repair] 输出被 token 上限截断，放大上限并要求精简后重新生成（${auto + 1}/${maxAuto}）\n`);
        const feedback = [
          userRepair?.feedback,
          '上一次输出因超出 token 上限被截断，JSON 不完整。请在保持功能完整的前提下精简输出：减少文件/页面数量，去掉注释、重复样板与冗长文案，确保完整、合法的 JSON 能在上限内输出完毕。',
        ]
          .filter(Boolean)
          .join('\n\n');
        repair = { feedback, previous: userRepair?.previous, previousError: failure.message, maxTokensLevel: truncations };
        trigger = 'auto-repair';
        continue;
      }

      if (failure?.errorClass === 'invalid_output' && auto < maxAuto) {
        onToken(`\n[auto-repair] 输出未通过校验，回喂错误后重新生成（${auto + 1}/${maxAuto}）\n`);
        const feedback = [
          userRepair?.feedback,
          `上一次输出未通过契约校验，请严格按要求的 JSON 结构重新输出完整结果。校验错误：${failure.message}`,
        ]
          .filter(Boolean)
          .join('\n\n');
        repair = { feedback, previous: userRepair?.previous, previousError: failure.message, maxTokensLevel: truncations || undefined };
        trigger = 'auto-repair';
        continue;
      }
      return { result, failure, logs };
    }
  }

  /**
   * 本流水线此前已消耗的用量（预算基线）。trace 读取失败时不能当 0（预算会在故障期间失效），
   * 退化为文档里各阶段已保存的 LLM 日志用量——只含每阶段最近一次执行，是下限估计，但好过没有。
   */
  private async priorUsage(docId: string, doc: PipelineDoc): Promise<{ promptTokens: number; completionTokens: number }> {
    try {
      return sumUsage(await this.trace.list(docId));
    } catch (e) {
      this.logger.warn(`读取 trace 失败，预算基线退化为文档内已保存日志的用量（下限估计）: ${(e as Error).message}`);
      return summarizeUsage(PIPELINE_STAGES.flatMap((s) => doc.stages[s]?.llmLogs ?? []));
    }
  }
}
