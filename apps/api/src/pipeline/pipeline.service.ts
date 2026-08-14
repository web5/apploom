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
    await this.enqueueStage(id, next);
    this.bus.emit(id, { type: 'job', status: 'running' });
    return true;
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
    await this.enqueueStage(id, target);
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
      this.bus.emit(docId, { type: 'stage', stage, status: 'running' });

      let result: StageRunResult;
      try {
        result = await this.runStage(stage, doc, (token) =>
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

      await this.store.update(docId, (d) => {
        d.stages[stage].status = 'done';
        d.stages[stage].result = result.result;
        d.stages[stage].raw = result.raw;
        d.stages[stage].summary = result.summary;
        d.stages[stage].finishedAt = new Date().toISOString();
      });
      this.bus.emit(docId, { type: 'stage', stage, status: 'done', summary: result.summary, result: result.result });
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

  /** 执行单个 Agent 阶段，输入取自上游阶段产出 */
  private async runStage(
    stage: PipelineStage,
    doc: PipelineDoc,
    onToken: (token: string) => void,
  ): Promise<StageRunResult> {
    switch (stage) {
      case 'requirement': {
        const r = await this.llm.generatePrd(doc.requirement, onToken);
        return { raw: r.raw, result: r.prd, summary: r.summary, error: r.error };
      }
      case 'design': {
        const r = await this.llm.generateDesign(doc.stages.requirement.result, onToken);
        return { raw: r.raw, result: r.design, summary: r.summary, error: r.error };
      }
      case 'codegen': {
        const r = await this.llm.generateCodegen(doc.stages.design.result, onToken);
        return { raw: r.raw, result: r.codegen, summary: r.summary, error: r.error };
      }
      case 'deploy': {
        const r = await this.llm.generateDeploy(doc.stages.codegen.result, onToken);
        return { raw: r.raw, result: r.deploy, summary: r.summary, error: r.error };
      }
    }
  }
}
