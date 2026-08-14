/**
 * PipelineBus —— worker 与 SSE 之间的进程内事件桥
 *
 * 为什么不用 Redis Pub/Sub？
 * BullMQ 的 Worker 和 NestJS API 跑在同一个进程里，事件即时可达；
 * Redis 只承担「任务状态持久化」。token 级推送走 EventEmitter 最省资源。
 *
 * 每个 job 一个事件名 `pipeline:{id}`，SSE 端点订阅，worker 侧 emit。
 */
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { PipelineEvent } from './pipeline.types';

@Injectable()
export class PipelineBus {
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

  /** SSE 侧订阅；返回取消订阅函数 */
  subscribe(id: string, listener: (event: PipelineEvent) => void): () => void {
    const channel = this.channel(id);
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
