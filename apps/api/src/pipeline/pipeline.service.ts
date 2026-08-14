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
import { LlmService } from '../prd/llm.service';
import { LocalDeployService } from '../deploy/local-deploy.service';
import { PipelineBus } from './pipeline.bus';
import { PipelineStore } from './pipeline.store';
import {
  PIPELINE_STAGES,
  PipelineDoc,
  PipelineEvent,
  PipelineStage,
  createPipelineDoc,
} from './pipeline.types';

export const PIPELINE_QUEUE = 'apploom-pipeline';

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

  /** SSE 订阅进度事件；返回取消函数 */
  subscribe(id: string, listener: (event: PipelineEvent) => void): () => void {
    return this.bus.subscribe(id, listener);
  }

  /** 逐步确认：确认当前等待的阶段，入队下一阶段 job */
  async confirm(id: string, stage: PipelineStage): Promise<boolean> {
    const doc = await this.store.get(id);
    if (!doc) return false;
    if (doc.status !== 'waiting_confirm' || doc.currentStage !== stage) return false;
    const next = this.nextStage(stage);
    if (!next) return false;

    // 异常链路兜底：若当前阶段之后全部已完成（如重试产生的手工状态），直接收尾为 completed
    const stageIdx = PIPELINE_STAGES.indexOf(stage);
    const allAfterDone = PIPELINE_STAGES.every((s, i) => i <= stageIdx || doc.stages[s].status === 'done');
    if (allAfterDone) {
      await this.store.update(id, (d) => {
        d.status = 'completed';
        d.currentStage = null;
      });
      const final = await this.store.get(id);
      if (final) this.bus.emit(id, { type: 'done', doc: final });
      this.logger.log(`pipeline ${id} 完成`);
      return true;
    }

    await this.store.update(id, (d) => {
      d.status = 'running';
      d.currentStage = next;
    });
    await this.emitSnapshot(id);
    await this.enqueueStage(id, next);
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
    const doc = await this.store.get(id);
    if (!doc) return false;
    // 允许重试「failed」阶段；崩溃残留的「running」阶段（BullMQ 已标 failed）也可重试
    const target =
      stage ??
      PIPELINE_STAGES.find(
        (s) => doc.stages[s].status === 'failed' || doc.stages[s].status === 'running',
      );
    if (!target) return false;
    if (doc.status !== 'failed' && doc.status !== 'running') return false;

    await this.store.update(id, (d) => {
      const st = d.stages[target];
      st.status = 'pending';
      st.error = undefined;
      st.result = undefined;
      st.raw = undefined;
      d.handoffs[target] = false;
      d.status = 'running';
      d.currentStage = target;
    });
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
    const doc = await this.store.get(id);
    if (!doc) return false;
    const state = doc.stages[stage];
    if (!state) return false;

    // feedback 省略 → 自动修复（用上次 error 兜底）；显式传（可为空串）→ 手动重跑
    const isAuto = feedback === undefined;
    const effectiveFeedback = isAuto ? state.error : (feedback ?? '').trim();
    // 自动修复必须有 error 才能修；手动重跑允许空反馈（无反馈重新生成）
    if (isAuto && !effectiveFeedback) return false;

    await this.store.update(id, (d) => {
      const st = d.stages[stage];
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
      const idx = PIPELINE_STAGES.indexOf(stage);
      for (const s of PIPELINE_STAGES.slice(idx + 1)) {
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
    });
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

    // —— 执行本阶段 ——
    if (!alreadyDone) {
      await this.store.update(docId, (d) => {
        d.status = 'running';
        d.currentStage = stage;
        d.stages[stage].status = 'running';
        d.stages[stage].error = undefined;
        d.stages[stage].startedAt = new Date().toISOString();
        d.stages[stage].attempts += 1;
      });
      await this.emitSnapshot(docId);
      this.bus.emit(docId, { type: 'stage', stage, status: 'running' });

      let result: StageRunResult;
      try {
        result = await this.runStage(stage, doc, docId, (token) =>
          this.bus.emit(docId, { type: 'token', stage, token }),
        );
        if (result.error) throw new Error(result.error);
      } catch (e) {
        const message = (e as Error).message;
        await this.store.update(docId, (d) => {
          d.status = 'failed';
          d.stages[stage].status = 'failed';
          d.stages[stage].error = message;
        });
        this.bus.emit(docId, { type: 'stage', stage, status: 'failed' });
        this.bus.emit(docId, { type: 'job', status: 'failed' });
        this.bus.emit(docId, { type: 'error', stage, message });
        throw e; // BullMQ 标失败，等 retry
      }

      // 阶段「产出失败但有 raw/result」（如 deploy install 失败）：保留 raw 供诊断，stage 标 failed
      const stageFailed = !!(result.result && typeof result.result === 'object' && (result.result as { status?: string }).status === 'failed');
      await this.store.update(docId, (d) => {
        if (stageFailed) {
          d.status = 'failed';
          d.stages[stage].status = 'failed';
          d.stages[stage].result = result.result;
          d.stages[stage].raw = result.raw;
          d.stages[stage].summary = result.summary;
          d.stages[stage].error = result.raw?.split('\n').filter(Boolean).slice(-1)[0] ?? '部署失败';
          d.stages[stage].finishedAt = new Date().toISOString();
        } else {
          d.stages[stage].status = 'done';
          d.stages[stage].result = result.result;
          d.stages[stage].raw = result.raw;
          d.stages[stage].summary = result.summary;
          d.stages[stage].finishedAt = new Date().toISOString();
        }
      });
      this.bus.emit(docId, { type: 'stage', stage, status: stageFailed ? 'failed' : 'done', summary: result.summary, result: result.result });
      if (stageFailed) {
        this.bus.emit(docId, { type: 'job', status: 'failed' });
        this.bus.emit(docId, { type: 'error', stage, message: result.raw?.split('\n').filter(Boolean).slice(-1)[0] ?? '部署失败' });
        throw new Error(`stage ${stage} failed`); // BullMQ 标失败，等 retry
      }
    }

    // —— 交接：确认模式挂起 / 自动模式入队下一阶段 / 最后阶段完成 ——
    const next = this.nextStage(stage);
    if (doc.confirmEachStep && next) {
      await this.store.update(docId, (d) => {
        d.handoffs[stage] = true;
        // 用户可能已确认推进（confirm 已把 currentStage 改成 next）→ 不覆盖
        if (d.status === 'waiting_confirm' || (d.status === 'running' && d.currentStage === stage)) {
          d.status = 'waiting_confirm';
        }
      });
      this.bus.emit(docId, { type: 'stage', stage, status: 'waiting_confirm' });
      this.bus.emit(docId, { type: 'job', status: 'waiting_confirm' });
      return;
    }

    if (next) {
      await this.store.update(docId, (d) => {
        d.handoffs[stage] = true;
      });
      await this.enqueueStage(docId, next);
    } else {
      // deploy 完成 → 整条流水线完成
      await this.store.update(docId, (d) => {
        d.handoffs[stage] = true;
        d.status = 'completed';
        d.currentStage = null;
      });
      this.bus.emit(docId, { type: 'job', status: 'completed' });
      const final = await this.store.get(docId);
      if (final) this.bus.emit(docId, { type: 'done', doc: final });
      this.logger.log(`pipeline ${docId} 完成`);
    }
  }

  private nextStage(stage: PipelineStage): PipelineStage | null {
    const i = PIPELINE_STAGES.indexOf(stage);
    return i >= 0 && i < PIPELINE_STAGES.length - 1 ? PIPELINE_STAGES[i + 1] : null;
  }

  private async enqueueStage(docId: string, stage: PipelineStage): Promise<void> {
    await this.queue.add(stage, { docId, stage });
  }

  /** 构造带反馈的重生成上下文（有 feedback 或上次失败时） */
  private buildRepair(stage: PipelineStage, doc: PipelineDoc): { feedback: string; previous?: unknown; previousError?: string } | undefined {
    const state = doc.stages[stage];
    if (!state.feedback) return undefined;
    const lastHistory = state.history?.[state.history.length - 1];
    return {
      feedback: state.feedback,
      previous: lastHistory?.result ?? state.result,
      previousError: lastHistory?.error,
    };
  }

  /** 执行单个 Agent 阶段，输入取自上游阶段产出 */
  private async runStage(
    stage: PipelineStage,
    doc: PipelineDoc,
    docId: string,
    onToken: (token: string) => void,
  ): Promise<StageRunResult> {
    const repair = this.buildRepair(stage, doc);
    switch (stage) {
      case 'requirement': {
        const r = await this.llm.generatePrd(doc.requirement, onToken, repair);
        return { raw: r.raw, result: r.prd, summary: r.summary, error: r.error };
      }
      case 'design': {
        const r = await this.llm.generateDesign(doc.stages.requirement.result, onToken, repair);
        return { raw: r.raw, result: r.design, summary: r.summary, error: r.error };
      }
      case 'codegen': {
        const r = await this.llm.generateCodegen(doc.stages.design.result, onToken, repair);
        return { raw: r.raw, result: r.codegen, summary: r.summary, error: r.error };
      }
      case 'deploy': {
        // W7+1: 本地真部署。不再让 LLM 描述，直接真实执行 codegen 产物。
        const codegen = doc.stages.codegen.result as {
          files: { path: string; content: string }[];
          dependencies: string[];
          runCommand: string;
        } | undefined;
        if (!codegen?.files?.length) {
          return { raw: '', error: '上游 codegen 产物为空，无法部署' };
        }
        const out = await this.deploySvc.deploy(docId, codegen, onToken);
        // 不通过 error 抛出：失败时让 processStage 走 store.update 分支保存 raw/result
        return {
          raw: out.buildLog,
          result: out,
          summary: { target: out.target, url: out.url, status: out.status, warnings: [] },
        };
      }
    }
  }
}
