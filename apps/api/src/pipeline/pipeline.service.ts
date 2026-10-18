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
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { LlmService } from '../prd/llm.service';
import { LocalDeployService } from '../deploy/local-deploy.service';
import { CodegenGateService } from '../gate/codegen-gate';
import { TraceStore } from '../trace/trace.store';
import { nextStageOf, stageNode } from '@apploom/shared';
import type { PipelineEventBus } from './pipeline.bus';
import { PipelineBus } from './pipeline.bus';
import { PipelineStore } from './pipeline.store';
import { createStageRunner } from './stage-handlers';
import { StageExecutor } from './stage-executor';
import { applyConfirm, applyHandoff, applyRepair, applyRetry, applyStageFailure, applyStageStart, applyStageSuccess, type HandoffKind } from './transitions';
import { AttemptRecord, PipelineDoc, PipelineDocSummary, PipelineEvent, PipelineStage, createPipelineDoc } from './pipeline.types';

/** 队列名可由 PIPELINE_QUEUE 覆盖：评测在独立队列里跑，避免与同时运行的开发 API 抢任务 */
export const PIPELINE_QUEUE = process.env.PIPELINE_QUEUE || 'apploom-pipeline';

/**
 * BullMQ job data：只携带 docId + 阶段 + 序号，状态全在 Redis doc 里。
 * seq = 这次入队意图对应的执行序号（入队时该阶段 attempts + 1）。jobId 由它拼成，所以：
 *   - 同一意图被重复入队（崩溃重启后重复调度、重复交接）→ jobId 相同，BullMQ 直接去重
 *   - 不同意图（重试 / 修复 / 再次确认）→ attempts 已变，seq 不同，不会被误吞
 * 老版本入队的 job 没有 seq，按旧行为处理。
 */
interface PipelineJobData {
  docId: string;
  stage: PipelineStage;
  seq?: number;
}

/** 入队幂等键。不能是纯数字（BullMQ 拒绝），这里用 文档id__阶段__序号 */
export function stageJobId(docId: string, stage: PipelineStage, seq: number): string {
  return `${docId}__${stage}__${seq}`;
}

/** 下一次执行该阶段时的序号：执行开始时 attempts 会 +1 */
const nextSeq = (doc: PipelineDoc, stage: PipelineStage): number => doc.stages[stage].attempts + 1;

@Injectable()
export class PipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineService.name);
  private queue: Queue;
  private worker: Worker;
  private connection: Redis;
  /** 执行单个阶段（含自动修复 / 截断自愈 / 预算守卫 / trace），见 stage-executor.ts */
  private readonly executor: StageExecutor;

  constructor(
    private readonly store: PipelineStore,
    // 接口在运行时不存在，Nest 无法按类型注入，必须显式指定令牌；换总线实现时只需 provide: PipelineBus, useClass: 新实现
    @Inject(PipelineBus) private readonly bus: PipelineEventBus,
    private readonly llm: LlmService,
    private readonly deploySvc: LocalDeployService,
    private readonly gate: CodegenGateService,
    private readonly trace: TraceStore,
  ) {
    this.executor = new StageExecutor(bus, trace, createStageRunner({ agents: llm, gate, deploy: deploySvc }));
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
    await this.enqueueStage(doc.id, 'requirement', nextSeq(doc, 'requirement'));
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
      const outcome = applyConfirm(d, stage);
      if (!outcome) skip();
      return outcome;
    });
    const outcome = r?.result;
    if (!r || !outcome) return false;

    if (outcome.kind === 'completed') {
      this.bus.emit(id, { type: 'done', doc: r.doc });
      this.logger.log(`pipeline ${id} 完成`);
      return true;
    }
    await this.emitSnapshot(id);
    await this.enqueueStage(id, outcome.next, nextSeq(r.doc, outcome.next));
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
      const target = applyRetry(d, stage);
      if (!target) skip();
      return target;
    });
    const target = r?.result;
    if (!target) return false;
    await this.emitSnapshot(id);
    await this.enqueueStage(id, target, nextSeq(r.doc, target));
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
      const ok = applyRepair(d, stage, feedback);
      if (!ok) skip();
      return ok;
    });
    if (!r?.result) return false;
    await this.emitSnapshot(id);
    await this.enqueueStage(id, stage, nextSeq(r.doc, stage));
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

    // 过期 job：阶段已被修复 / 重试重置为 pending，而这个 job 对应的是更早的一次入队意图 → 丢弃，由新意图的 job 负责。
    // 只校验 pending：running（崩溃后被重新投递）与 done（交接前崩溃）都要继续跑，靠 handoffs / 执行身份保证幂等
    if (job.data.seq !== undefined && state.status === 'pending' && job.data.seq !== nextSeq(doc, stage)) {
      this.logger.warn(`pipeline ${docId} 阶段 ${stage} 的 job（seq=${job.data.seq}）已过期（当前应为 ${nextSeq(doc, stage)}），丢弃`);
      return;
    }

    // 幂等：阶段已完成且交接已完成（崩溃后 job 重新入队）→ 直接返回
    if (alreadyDone && doc.handoffs[stage]) return;

    // 本次执行的「身份」：开始执行时 attempts 自增后的值。之后所有写入都要确认自己仍是当前这次执行——
    // 用户在阶段运行期间点了「修复/重试」，旧执行跑完时不能把新状态盖掉。
    let myAttempt = state.attempts;

    // —— 执行本阶段 ——
    if (!alreadyDone) {
      const started = await this.store.mutate(docId, (d) => applyStageStart(d, stage));
      if (!started) throw new Error(`pipeline ${docId} 不存在`);
      myAttempt = started.result;
      await this.emitSnapshot(docId);
      this.bus.emit(docId, { type: 'stage', stage, status: 'running' });

      const outcome = await this.executor.execute(docId, stage, doc, myAttempt);
      const { result, failure, logs } = outcome;

      if (failure) {
        // 失败也保留 LLM 日志；deploy 这类「有产出但执行失败」的阶段额外保留 result/raw 供诊断
        const written = await this.store.mutate(docId, (d, skip) => {
          const ok = applyStageFailure(d, stage, myAttempt, failure, logs, result);
          if (!ok) skip();
          return ok;
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
        const ok = applyStageSuccess(d, stage, myAttempt, result!, logs);
        if (!ok) skip();
        return ok;
      });
      if (!written?.result) return this.logSuperseded(docId, stage, myAttempt, '成功');
      this.bus.emit(docId, { type: 'stage', stage, status: 'done', summary: result!.summary, result: result!.result });
    }

    // —— 交接：确认模式挂起 / 自动模式入队下一阶段 / 最后阶段完成 ——
    // 要求本次执行仍是当前这次（done 且 attempts 未变），否则说明已被修复/重试取代，不能代它交接
    const next = nextStageOf(stage);
    const kind: HandoffKind = !next ? 'complete' : doc.confirmEachStep && stageNode(stage).needsConfirmation ? 'wait' : 'advance';
    const handed = await this.store.mutate(docId, (d, skip) => {
      const ok = applyHandoff(d, stage, myAttempt, kind);
      if (!ok) skip();
      return ok;
    });
    if (!handed?.result) return this.logSuperseded(docId, stage, myAttempt, '交接');

    if (kind === 'wait') {
      this.bus.emit(docId, { type: 'stage', stage, status: 'waiting_confirm' });
      this.bus.emit(docId, { type: 'job', status: 'waiting_confirm' });
    } else if (kind === 'advance') {
      await this.enqueueStage(docId, next!, nextSeq(handed.doc, next!));
    } else {
      this.bus.emit(docId, { type: 'job', status: 'completed' });
      this.bus.emit(docId, { type: 'done', doc: handed.doc });
      this.logger.log(`pipeline ${docId} 完成`);
    }
  }

  private logSuperseded(docId: string, stage: PipelineStage, attempt: number, what: string): void {
    this.logger.warn(`pipeline ${docId} 阶段 ${stage} 第 ${attempt} 次执行已被修复/重试取代，丢弃其${what}结果`);
  }

  private async enqueueStage(docId: string, stage: PipelineStage, seq: number): Promise<void> {
    await this.queue.add(stage, { docId, stage, seq }, { jobId: stageJobId(docId, stage, seq) });
  }
}
