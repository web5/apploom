/**
 * PipelineService —— W7 异步流水线核心（链式 job 设计）
 *
 * 设计：**每个 Agent 阶段是一个独立的 BullMQ job**，完成后「交接」给下一阶段：
 *   - 自动模式：本阶段 job 完成后直接入队下一阶段 job（链式调用）
 *   - 逐步确认：本阶段 job 完成后挂起（job 正常结束，不占队列），
 *     等 POST /confirm 后入队下一阶段 job
 *   - 失败重试：POST /retry 重新入队失败阶段的 job（断点续跑）
 *
 * 为什么不用「一个 job 跑完整条流水线 + 进程内等待确认」？
 *  BullMQ 的 job 锁机制（lockDuration 默认 30s）会检测"卡住"的 job，
 *  无限期等待确认会触发 stalled → failed；进程重启后锁丢失也一样。
 *  每阶段一个 job 没有这种等待，且天然契合重试与崩溃恢复。
 *
 * 幂等：doc.handoffs[stage] 标记「该阶段已完成交接」，
 *  job 重复执行（重启后 BullMQ 重新入队）时直接跳过，避免链式重复入队。
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { LlmService, type RepairContext } from '../prd/llm.service';
import { LocalDeployService } from '../deploy/local-deploy.service';
import { CodegenGateService, formatFailures, gateMaxRepairs, gateMode } from '../gate/codegen-gate';
import { TraceStore, summarizeUsage } from '../trace/trace.store';
import { assertWithinBudget, pipelineTokenBudget, sumUsage, totalTokens } from '../trace/budget';
import { saveArtifact } from '../artifacts/artifact';
import { classifyError } from '@apploom/llm';
import { STAGE_LABEL, downstreamOf, nextStageOf, stageNode, upstreamOf } from '@apploom/shared';
import { PipelineBus } from './pipeline.bus';
import { PipelineStore } from './pipeline.store';
import {
  PIPELINE_STAGES,
  AttemptRecord,
  AttemptTrigger,
  ErrorClass,
  LlmLogEntry,
  PipelineDoc,
  PipelineDocSummary,
  PipelineEvent,
  PipelineStage,
  createPipelineDoc,
} from './pipeline.types';

/** 队列名可由 PIPELINE_QUEUE 覆盖：评测在独立队列里跑，避免与同时运行的开发 API 抢任务 */
export const PIPELINE_QUEUE = process.env.PIPELINE_QUEUE || 'apploom-pipeline';

/** BullMQ job data：只携带 docId + 当前阶段，状态全在 Redis doc 里 */
interface PipelineJobData {
  docId: string;
  stage: PipelineStage;
}

interface StageRunResult {
  raw: string;
  result?: unknown;
  summary?: unknown;
  error?: string;
  /** error 的类别；缺省按 invalid_output（模型输出未通过解析/契约校验）处理 */
  errorClass?: ErrorClass;
  llmLogs?: LlmLogEntry[];
}

interface StageFailure {
  message: string;
  errorClass: ErrorClass;
  /** 失败时仍保留 result/raw（如 deploy 已执行但失败，需保留日志供诊断） */
  keepResult?: boolean;
}

interface StageOutcome {
  result?: StageRunResult;
  failure?: StageFailure;
  logs: LlmLogEntry[];
}

/** 模型输出不合规（含被 token 上限截断）时，自动回喂错误重新生成的最大轮数（STAGE_AUTO_REPAIRS，默认 1） */
function stageAutoRepairs(): number {
  const n = Number(process.env.STAGE_AUTO_REPAIRS ?? 1);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

@Injectable()
export class PipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineService.name);
  private queue: Queue;
  private worker: Worker;
  private connection: Redis;

  constructor(
    private readonly store: PipelineStore,
    private readonly bus: PipelineBus,
    private readonly llm: LlmService,
    private readonly deploySvc: LocalDeployService,
    private readonly gate: CodegenGateService,
    private readonly trace: TraceStore,
  ) {
    this.connection = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null, // BullMQ 要求
    });
  }

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(PIPELINE_QUEUE, { connection: this.connection });
    this.worker = new Worker(PIPELINE_QUEUE, (job) => this.processStage(job), {
      connection: this.connection,
      // 崩溃后允许重新入队一次再失败，配合 doc.handoffs 幂等跳过
      maxStalledCount: 2,
    });
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`pipeline ${job?.data?.docId} 阶段 ${job?.name} 失败: ${err.message}`),
    );
    this.logger.log(`Pipeline Worker 已启动（${PIPELINE_QUEUE}）`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit();
  }

  /** 创建异步任务：写 Redis doc + 入队第一阶段，立即返回 jobId */
  async create(requirement: string, confirmEachStep = true): Promise<string> {
    const doc = createPipelineDoc(requirement.trim(), confirmEachStep);
    doc.id = randomUUID();
    doc.currentStage = 'requirement';
    await this.store.save(doc);
    await this.enqueueStage(doc.id, 'requirement');
    return doc.id;
  }

  get(id: string): Promise<PipelineDoc | null> {
    return this.store.get(id);
  }

  list(): Promise<PipelineDocSummary[]> {
    return this.store.list();
  }

  /** 阶段执行记录（Attempt）；brief=true 时省略体积大的 llmLogs */
  async listAttempts(id: string, stage?: PipelineStage, brief = true): Promise<Array<AttemptRecord | Omit<AttemptRecord, 'llmLogs'>>> {
    const records = await this.trace.list(id, stage);
    return brief ? records.map(({ llmLogs: _omit, ...rest }) => rest) : records;
  }

  getAttempt(id: string, attemptId: string): Promise<AttemptRecord | null> {
    return this.trace.get(id, attemptId);
  }

  /** SSE 订阅进度事件；返回取消函数 */
  subscribe(id: string, listener: (event: PipelineEvent) => void): () => void {
    return this.bus.subscribe(id, listener);
  }

  /**
   * 逐步确认：确认当前等待的阶段，入队下一阶段 job。
   * 状态检查与推进在同一次原子修改里完成：连点两次确认时只有第一次通过，不会重复入队。
   */
  async confirm(id: string, stage: PipelineStage): Promise<boolean> {
    const r = await this.store.mutate(id, (d, skip) => {
      const next = this.nextStage(stage);
      if (d.status !== 'waiting_confirm' || d.currentStage !== stage || !next) {
        skip();
        return null;
      }
      // 异常链路兜底：若当前阶段之后全部已完成（如重试产生的手工状态），直接收尾为 completed
      const stageIdx = PIPELINE_STAGES.indexOf(stage);
      const allAfterDone = PIPELINE_STAGES.every((s, i) => i <= stageIdx || d.stages[s].status === 'done');
      if (allAfterDone) {
        d.status = 'completed';
        d.currentStage = null;
        return { kind: 'completed' as const };
      }
      d.status = 'running';
      d.currentStage = next;
      return { kind: 'advance' as const, next };
    });
    const outcome = r?.result;
    if (!r || !outcome) return false;

    if (outcome.kind === 'completed') {
      this.bus.emit(id, { type: 'done', doc: r.doc });
      this.logger.log(`pipeline ${id} 完成`);
      return true;
    }
    await this.emitSnapshot(id);
    await this.enqueueStage(id, outcome.next);
    this.bus.emit(id, { type: 'job', status: 'running' });
    return true;
  }

  /** 推一次完整快照，让前端同步 currentStage 等字段（job 事件只带 status，不含 currentStage） */
  private async emitSnapshot(id: string): Promise<void> {
    const doc = await this.store.get(id);
    if (doc) this.bus.emit(id, { type: 'snapshot', doc });
  }

  /** 失败重试：把 failed 阶段重置为 pending 重新入队，其余已产出保留 */
  async retry(id: string, stage?: PipelineStage): Promise<boolean> {
    const r = await this.store.mutate(id, (d, skip) => {
      // 允许重试「failed」阶段；崩溃残留的「running」阶段（BullMQ 已标 failed）也可重试
      const target =
        stage ??
        PIPELINE_STAGES.find((s) => d.stages[s].status === 'failed' || d.stages[s].status === 'running');
      if (!target || (d.status !== 'failed' && d.status !== 'running')) {
        skip();
        return null;
      }
      const st = d.stages[target];
      st.status = 'pending';
      st.error = undefined;
      st.result = undefined;
      st.raw = undefined;
      d.handoffs[target] = false;
      d.status = 'running';
      d.currentStage = target;
      return target;
    });
    const target = r?.result;
    if (!target) return false;
    await this.emitSnapshot(id);
    await this.enqueueStage(id, target);
    this.bus.emit(id, { type: 'job', status: 'running' });
    return true;
  }

  /**
   * AI 修复/修改：带反馈重新生成某个阶段。
   *   - feedback 显式传入 → 手动修复（用户填修改意见）
   *   - feedback 省略 → 自动修复（用上次 error 作为反馈）
   *
   * 关键：把当前 result/error 归档到 history，LLM 能参考「上次产出 + 反馈」修正，
   * 而不是无脑重跑。下游阶段（handoffs）清空，修完后重新跑。
   */
  async repair(id: string, stage: PipelineStage, feedback?: string): Promise<boolean> {
    const r = await this.store.mutate(id, (d, skip) => {
      const st = d.stages[stage];
      if (!st) {
        skip();
        return false;
      }
      // feedback 省略 → 自动修复（用上次 error 兜底）；显式传（可为空串）→ 手动重跑
      const isAuto = feedback === undefined;
      const effectiveFeedback = isAuto ? st.error : (feedback ?? '').trim();
      // 自动修复必须有 error 才能修；手动重跑允许空反馈（无反馈重新生成）
      if (isAuto && !effectiveFeedback) {
        skip();
        return false;
      }

      // 归档上次产出（成功产出或失败 error），供 LLM 参考
      if (!st.history) st.history = [];
      st.history.push({ result: st.result, error: st.error });
      // 有反馈才保存；空反馈 = 无反馈重跑（buildRepair 因空串返回 undefined）
      if (effectiveFeedback) st.feedback = effectiveFeedback;
      else delete st.feedback;
      // 重置本阶段，清掉旧产出
      st.status = 'pending';
      st.result = undefined;
      st.raw = undefined;
      st.error = undefined;
      st.summary = undefined;
      d.handoffs[stage] = false;
      // 下游阶段要重新跑（上游变了，下游产出作废）
      for (const s of downstreamOf(stage)) {
        if (d.stages[s].status === 'done' || d.stages[s].status === 'failed') {
          d.stages[s].status = 'pending';
          d.stages[s].result = undefined;
          d.stages[s].raw = undefined;
          d.stages[s].error = undefined;
          d.stages[s].summary = undefined;
        }
        d.handoffs[s] = false;
      }
      d.status = 'running';
      d.currentStage = stage;
      return true;
    });
    if (!r?.result) return false;
    await this.emitSnapshot(id);
    await this.enqueueStage(id, stage);
    this.bus.emit(id, { type: 'job', status: 'running' });
    return true;
  }

  // ===================== Worker 处理器 =====================

  /** 处理单个阶段 job（链式交接） */
  private async processStage(job: Job<PipelineJobData>): Promise<void> {
    const { docId, stage } = job.data;
    const doc = await this.store.get(docId);
    if (!doc) throw new Error(`pipeline ${docId} 不存在`);

    const state = doc.stages[stage];
    const alreadyDone = state.status === 'done';

    // 幂等：阶段已完成且交接已完成（崩溃后 job 重新入队）→ 直接返回
    if (alreadyDone && doc.handoffs[stage]) return;

    // 本次执行的「身份」：开始执行时 attempts 自增后的值。之后所有写入都要确认自己仍是当前这次执行——
    // 用户在阶段运行期间点了「修复/重试」，旧执行跑完时不能把新状态盖掉。
    let myAttempt = state.attempts;

    // —— 执行本阶段 ——
    if (!alreadyDone) {
      const started = await this.store.mutate(docId, (d) => {
        d.status = 'running';
        d.currentStage = stage;
        d.stages[stage].status = 'running';
        d.stages[stage].error = undefined;
        d.stages[stage].errorClass = undefined;
        d.stages[stage].startedAt = new Date().toISOString();
        d.stages[stage].attempts += 1;
        return d.stages[stage].attempts;
      });
      if (!started) throw new Error(`pipeline ${docId} 不存在`);
      myAttempt = started.result;
      await this.emitSnapshot(docId);
      this.bus.emit(docId, { type: 'stage', stage, status: 'running' });

      const outcome = await this.executeAttempts(docId, stage, doc, myAttempt);
      const { result, failure, logs } = outcome;

      if (failure) {
        // 失败也保留 LLM 日志；deploy 这类「有产出但执行失败」的阶段额外保留 result/raw 供诊断
        const written = await this.store.mutate(docId, (d, skip) => {
          if (!this.isCurrentRun(d, stage, myAttempt)) {
            skip();
            return false;
          }
          const st = d.stages[stage];
          d.status = 'failed';
          st.status = 'failed';
          st.error = failure.message;
          st.errorClass = failure.errorClass;
          st.llmLogs = logs;
          st.finishedAt = new Date().toISOString();
          if (failure.keepResult && result) {
            st.result = result.result;
            st.raw = result.raw;
            st.summary = result.summary;
          }
          return true;
        });
        if (!written?.result) return this.logSuperseded(docId, stage, myAttempt, '失败');
        this.logger.warn(`pipeline ${docId} 阶段 ${stage} 失败 [${failure.errorClass}]: ${failure.message.split('\n')[0]}`);
        this.bus.emit(docId, {
          type: 'stage',
          stage,
          status: 'failed',
          error: failure.message,
          errorClass: failure.errorClass,
          ...(failure.keepResult && result ? { summary: result.summary, result: result.result } : {}),
        });
        this.bus.emit(docId, { type: 'job', status: 'failed' });
        this.bus.emit(docId, { type: 'error', stage, message: failure.message });
        throw new Error(failure.keepResult ? `stage ${stage} failed` : failure.message); // BullMQ 标失败，等 retry
      }

      const written = await this.store.mutate(docId, (d, skip) => {
        if (!this.isCurrentRun(d, stage, myAttempt)) {
          skip();
          return false;
        }
        const st = d.stages[stage];
        st.status = 'done';
        st.result = result!.result;
        st.raw = result!.raw;
        st.summary = result!.summary;
        st.llmLogs = logs;
        st.finishedAt = new Date().toISOString();
        return true;
      });
      if (!written?.result) return this.logSuperseded(docId, stage, myAttempt, '成功');
      this.bus.emit(docId, { type: 'stage', stage, status: 'done', summary: result!.summary, result: result!.result });
    }

    // —— 交接：确认模式挂起 / 自动模式入队下一阶段 / 最后阶段完成 ——
    // 同样要求本次执行仍是当前这次（done 且 attempts 未变），否则说明已被修复/重试取代，不能代它交接
    const next = this.nextStage(stage);
    if (doc.confirmEachStep && stageNode(stage).needsConfirmation && next) {
      const handed = await this.store.mutate(docId, (d, skip) => {
        if (!this.isCurrentDone(d, stage, myAttempt)) {
          skip();
          return false;
        }
        d.handoffs[stage] = true;
        // 用户可能已确认推进（confirm 已把 currentStage 改成 next）→ 不覆盖
        if (d.status === 'waiting_confirm' || (d.status === 'running' && d.currentStage === stage)) {
          d.status = 'waiting_confirm';
        }
        return true;
      });
      if (!handed?.result) return this.logSuperseded(docId, stage, myAttempt, '交接');
      this.bus.emit(docId, { type: 'stage', stage, status: 'waiting_confirm' });
      this.bus.emit(docId, { type: 'job', status: 'waiting_confirm' });
      return;
    }

    if (next) {
      const handed = await this.store.mutate(docId, (d, skip) => {
        if (!this.isCurrentDone(d, stage, myAttempt)) {
          skip();
          return false;
        }
        d.handoffs[stage] = true;
        return true;
      });
      if (!handed?.result) return this.logSuperseded(docId, stage, myAttempt, '交接');
      await this.enqueueStage(docId, next);
    } else {
      // deploy 完成 → 整条流水线完成
      const finished = await this.store.mutate(docId, (d, skip) => {
        if (!this.isCurrentDone(d, stage, myAttempt)) {
          skip();
          return false;
        }
        d.handoffs[stage] = true;
        d.status = 'completed';
        d.currentStage = null;
        return true;
      });
      if (!finished?.result) return this.logSuperseded(docId, stage, myAttempt, '收尾');
      this.bus.emit(docId, { type: 'job', status: 'completed' });
      this.bus.emit(docId, { type: 'done', doc: finished.doc });
      this.logger.log(`pipeline ${docId} 完成`);
    }
  }

  /** 该阶段仍处于「我这次执行」：正在运行且 attempts 未被后续执行改动 */
  private isCurrentRun(d: PipelineDoc, stage: PipelineStage, attempt: number): boolean {
    return d.stages[stage].status === 'running' && d.stages[stage].attempts === attempt;
  }

  /** 该阶段的完成态仍是「我这次执行」产出的 */
  private isCurrentDone(d: PipelineDoc, stage: PipelineStage, attempt: number): boolean {
    return d.stages[stage].status === 'done' && d.stages[stage].attempts === attempt;
  }

  private logSuperseded(docId: string, stage: PipelineStage, attempt: number, what: string): void {
    this.logger.warn(`pipeline ${docId} 阶段 ${stage} 第 ${attempt} 次执行已被修复/重试取代，丢弃其${what}结果`);
  }

  private nextStage(stage: PipelineStage): PipelineStage | null {
    return nextStageOf(stage);
  }

  private async enqueueStage(docId: string, stage: PipelineStage): Promise<void> {
    await this.queue.add(stage, { docId, stage });
  }

  /** 构造带反馈的重生成上下文（有 feedback 或上次失败时） */
  private buildRepair(stage: PipelineStage, doc: PipelineDoc): RepairContext | undefined {
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
  private async executeAttempts(docId: string, stage: PipelineStage, doc: PipelineDoc, firstN: number): Promise<StageOutcome> {
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
      let failure: StageFailure | undefined;

      // 预算守卫：基线 = 本流水线此前所有执行的用量；每次调用模型前再叠加本次已产生的用量
      const baseline = totalTokens(await this.priorUsage(docId, doc));
      const guard = () => assertWithinBudget(baseline + totalTokens(summarizeUsage(logs)));

      try {
        guard();
        result = await this.runStage(stage, doc, docId, onToken, logs, repair, guard);
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
   * 代码生成 + 确定性门禁：生成 → 校验 → 未通过则把结构化失败回喂模型重新生成（最多 N 轮）。
   * enforce 模式耗尽修复轮数后阶段失败；warn 模式只把失败记入 summary.warnings。
   */
  private async runCodegenWithGate(
    docId: string,
    doc: PipelineDoc,
    userRepair: RepairContext | undefined,
    onToken: (token: string) => void,
    onLog: (entry: LlmLogEntry) => void,
    logs: LlmLogEntry[],
    guard: () => void,
  ): Promise<StageRunResult> {
    const generate = (repair: typeof userRepair) =>
      this.llm.generateCodegen(doc.stages.design.result, doc.stages.prototype.result, onToken, repair, onLog);

    let r = await generate(userRepair);
    const mode = gateMode();
    if (mode === 'off' || r.error || !r.codegen) {
      return { raw: r.raw, result: r.codegen, summary: r.summary, error: r.error, errorClass: r.errorClass, llmLogs: logs };
    }

    const maxRepairs = gateMaxRepairs();
    for (let round = 0; ; round++) {
      onToken(`\n[gate] 第 ${round + 1} 轮校验…\n`);
      const report = await this.gate.verify(docId, r.codegen, (line) => onToken(`${line}\n`));
      const gateSummary = { mode, passed: report.passed, repairRounds: round, checks: report.checks };

      if (report.passed) {
        return { raw: r.raw, result: r.codegen, summary: { ...r.summary, gate: gateSummary }, llmLogs: logs };
      }

      if (round >= maxRepairs) {
        const failureText = formatFailures(report.failures);
        if (mode === 'warn') {
          const warnings = [...(r.summary?.warnings ?? []), ...report.failures.map((f) => `[gate:${f.check}] ${f.message}`)];
          return { raw: r.raw, result: r.codegen, summary: { ...r.summary, warnings, gate: { ...gateSummary, failures: report.failures } }, llmLogs: logs };
        }
        return { raw: r.raw, error: `代码门禁未通过（已自动修复 ${round} 轮）：\n${failureText}`, errorClass: 'verification', llmLogs: logs };
      }

      onToken(`[gate] 未通过（${report.failures.length} 项），回喂模型修复…\n`);
      const feedback = [userRepair?.feedback, formatFailures(report.failures)].filter(Boolean).join('\n\n');
      guard();
      r = await generate({ feedback, previous: r.codegen, maxTokensLevel: userRepair?.maxTokensLevel });
      if (r.error || !r.codegen) {
        return { raw: r.raw, error: r.error ?? '修复轮次未产出有效代码', errorClass: r.errorClass, llmLogs: logs };
      }
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

  /** 各阶段依赖的上游产物；缺失时直接失败，不能把 undefined 拼进 prompt */
  /** 各阶段必须已产出的上游（由 STAGE_GRAPH 的入边推导） */
  private static readonly UPSTREAM = Object.fromEntries(
    PIPELINE_STAGES.map((s) => [s, upstreamOf(s).map((u) => ({ stage: u, label: STAGE_LABEL[u] }))]),
  ) as Record<PipelineStage, Array<{ stage: PipelineStage; label: string }>>;

  /** 执行单个 Agent 阶段，输入取自上游阶段产出 */
  private async runStage(
    stage: PipelineStage,
    doc: PipelineDoc,
    docId: string,
    onToken: (token: string) => void,
    logs: LlmLogEntry[],
    repair: RepairContext | undefined,
    guard: () => void,
  ): Promise<StageRunResult> {
    const onLog = (entry: LlmLogEntry) => logs.push(entry);
    const missing = PipelineService.UPSTREAM[stage]?.find((u) => !doc.stages[u.stage]?.result);
    if (missing) {
      return { raw: '', error: `上游「${missing.label}」产物缺失，无法继续（请先完成该阶段）`, errorClass: 'invalid_input', llmLogs: logs };
    }
    switch (stage) {
      case 'requirement': {
        const r = await this.llm.generatePrd(doc.requirement, onToken, repair, onLog);
        return { raw: r.raw, result: r.prd, summary: r.summary, error: r.error, errorClass: r.errorClass, llmLogs: logs };
      }
      case 'prototype': {
        const r = await this.llm.generatePrototype(doc.stages.requirement.result, onToken, repair, onLog);
        // 完整 HTML 另存为文件（doc 里仍保留一份供前端预览）；写文件失败不影响阶段结果
        const html = (r.prototype as { html?: unknown } | undefined)?.html;
        const htmlFile = typeof html === 'string' ? await saveArtifact(docId, 'prototype.html', html).catch(() => undefined) : undefined;
        return { raw: r.raw, result: r.prototype, summary: htmlFile && r.summary ? { ...r.summary, htmlFile } : r.summary, error: r.error, errorClass: r.errorClass, llmLogs: logs };
      }
      case 'design': {
        const r = await this.llm.generateDesign(
          doc.stages.requirement.result,
          doc.stages.prototype.result,
          onToken,
          repair,
          onLog,
        );
        return { raw: r.raw, result: r.design, summary: r.summary, error: r.error, errorClass: r.errorClass, llmLogs: logs };
      }
      case 'codegen':
        return this.runCodegenWithGate(docId, doc, repair, onToken, onLog, logs, guard);
      case 'deploy': {
        const codegen = doc.stages.codegen.result as {
          files: { path: string; content: string }[];
          dependencies: string[];
          runCommand: string;
        } | undefined;
        if (!codegen?.files?.length) {
          return { raw: '', error: '上游 codegen 产物为空，无法部署', errorClass: 'invalid_input' };
        }

        // 1) LLM 决策部署方案（target: local / cloud / git），repair 反馈也走 LLM
        const r = await this.llm.generateDeploy(codegen, onToken, repair, onLog);
        if (r.error) return { raw: r.raw, error: r.error, errorClass: r.errorClass, llmLogs: logs };
        const deploy = r.deploy as {
          target: 'local' | 'cloud' | 'git';
          url: string;
          repoUrl: string;
          buildLog: string;
          status: 'success' | 'failed';
          port?: number;
        } | undefined;
        if (!deploy) return { raw: r.raw, error: '部署方案解析失败', llmLogs: logs };

        // 2) 只有 local 有真实执行器。cloud / git 没有 executor：不能把 LLM 编出来的 url / repoUrl 当成部署结果（假成功），
        //    按「模型输出不合规」处理，让自动修复把约束回喂给模型重新决策
        if (deploy.target !== 'local') {
          return {
            raw: r.raw,
            error: `部署目标「${deploy.target}」当前没有执行器，只支持 local。请把 target 改为 "local" 并给出本地 dev server 端口；不要虚构 url / repoUrl。`,
            errorClass: 'invalid_output',
            llmLogs: logs,
          };
        }

        // 3) local → LocalDeployService 真实执行，用真实结果覆盖 LLM 的占位值
        const out = await this.deploySvc.deploy(docId, codegen, onToken, deploy.port);
        const merged = { ...deploy, url: out.url, buildLog: out.buildLog, status: out.status };
        return {
          raw: out.buildLog,
          result: merged,
          summary: { target: 'local', url: out.url, status: out.status, warnings: [] },
          llmLogs: logs,
        };
      }
    }
  }
}
