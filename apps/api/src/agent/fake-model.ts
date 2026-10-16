/**
 * FakeAgent：脚本化的假模型客户端，按顺序返回预设回复，并记录每次调用收到的参数。
 * 用来在不碰网络、不花 token 的情况下测试 AgentRunner 与上层编排。
 */
import type { ChatResult } from '@apploom/llm';
import type { ChatFn } from './agent-runner';

export interface ScriptedReply {
  content: string;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export type RecordedCall = Parameters<ChatFn>[1];

export interface ScriptedChat extends ChatFn {
  calls: RecordedCall[];
}

/** replies 用完后重复最后一条，便于表达「一直返回同样的坏输出」 */
export function scriptedChat(replies: ScriptedReply[]): ScriptedChat {
  const calls: RecordedCall[] = [];
  const fn = (async (_config, options): Promise<ChatResult> => {
    const reply = replies[Math.min(calls.length, replies.length - 1)];
    calls.push(options);
    options.onToken?.(reply.content);
    const usage = reply.usage ?? { promptTokens: 10, completionTokens: 5 };
    const finishReason = reply.finishReason ?? 'stop';
    options.onLog?.({ label: options.label ?? 'fake', ts: new Date().toISOString(), user: options.user, response: reply.content, usage, finishReason });
    return { content: reply.content, usage, finishReason };
  }) as ScriptedChat;
  fn.calls = calls;
  return fn;
}
