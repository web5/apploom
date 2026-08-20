/**
 * ToolSessionLog —— 追加式工具调用日志
 *
 * 对应 dsh 的 append-only session log：模型所见的一切（工具调用/结果/错误）都记录成
 * 单一事件流，支持序列化、重放与审计。日志不可变，只追加。
 *
 * 后续接 LLM tool-use 时，可把事件流作为工具调用历史回传给模型（反馈循环）；
 * 接逐步确认时，可用于「恢复/分叉」某次执行。
 */
import { ToolLogEvent, ToolLogEventInput } from './types';

export class ToolSessionLog {
  private readonly events: ToolLogEvent[] = [];

  append(event: ToolLogEventInput): ToolLogEvent {
    const full: ToolLogEvent = { ...event, ts: new Date().toISOString() } as ToolLogEvent;
    this.events.push(full);
    return full;
  }

  /** 追加式不可变：返回只读副本 */
  all(): readonly ToolLogEvent[] {
    return this.events as readonly ToolLogEvent[];
  }

  get length(): number {
    return this.events.length;
  }

  /** 序列化（JSON 持久化 / 传给前端） */
  toJSON(): string {
    return JSON.stringify(this.events, null, 2);
  }

  /** 重放：把历史事件逐个喂给回调（可用于恢复渲染 / 审计 / 训练收集） */
  replay(fn: (event: ToolLogEvent) => void): void {
    for (const e of this.events) fn(e);
  }
}
