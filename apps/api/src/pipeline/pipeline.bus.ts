/**
 * PipelineBus —— worker 与 SSE 之间的事件桥（当前实现：进程内）
 *
 * 为什么现在不用 Redis Pub/Sub？
 * BullMQ 的 Worker 和 NestJS API 跑在同一个进程里，事件即时可达；
 * Redis 只承担「任务状态持久化」。token 级推送走 EventEmitter 最省资源。
 * **限制：API 与 worker 分进程部署后，进程内总线会丢事件**——到时换一个实现同一接口（PipelineEventBus）的
 * Redis 版，并通过 pipeline.bus.contract.ts 的契约测试即可，消费方只依赖接口，不用改。
 *
 * 每个 job 一个事件名 `pipeline:{id}`，SSE 端点订阅，worker 侧 emit。
 */
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { PipelineEvent } from './pipeline.types';

/** 事件总线契约：消费方（服务 / 执行器 / 审批 / SSE）只依赖它，不依赖具体实现 */
export interface PipelineEventBus {
  /** 推送事件。投递是尽力而为、不阻塞调用方；没有订阅者时静默丢弃 */
  emit(id: string, event: PipelineEvent): void;
  /** 订阅某条流水线的事件；返回取消订阅函数（可重复调用） */
  subscribe(id: string, listener: (event: PipelineEvent) => void): () => void;
}

@Injectable()
export class PipelineBus implements PipelineEventBus {
  private readonly logger = new Logger(PipelineBus.name);
  private readonly emitter = new EventEmitter();
  // 比默认 10 更大，避免长时间流式任务触发 MaxListenersExceededWarning
  private readonly MAX_LISTENERS = 100;

  constructor() {
    this.emitter.setMaxListeners(this.MAX_LISTENERS);
  }

  private channel(id: string): string {
    return `pipeline:${id}`;
  }

  /** worker 侧推送事件 */
  emit(id: string, event: PipelineEvent): void {
    this.emitter.emit(this.channel(id), event);
  }

  /**
   * SSE 侧订阅；返回取消订阅函数。
   * 监听器被包了一层：EventEmitter 是同步投递，订阅者抛错会沿 emit 传回 worker（让正在跑的阶段失败），
   * 还会让同一事件的后续订阅者收不到。一个页面的连接出问题不该影响流水线和其它页面。
   */
  subscribe(id: string, listener: (event: PipelineEvent) => void): () => void {
    const channel = this.channel(id);
    const safe = (event: PipelineEvent) => {
      try {
        listener(event);
      } catch (e) {
        this.logger.warn(`pipeline ${id} 的事件订阅者抛错（已忽略，不影响流水线）: ${(e as Error).message}`);
      }
    };
    this.emitter.on(channel, safe);
    return () => this.emitter.off(channel, safe);
  }
}
