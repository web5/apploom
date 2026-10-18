import { describe, expect, it, vi } from 'vitest';
import { connectRunEvents, parseRunEvent, RUN_EVENT_NAMES, type EventSourceLike } from './sse.adapter';
import type { RunAction } from './run.reducer';

const doc = { id: 'd1', status: 'running' };

describe('parseRunEvent', () => {
  it('快照兼容直接推 doc 与 { doc } 两种形态', () => {
    expect(parseRunEvent('snapshot', JSON.stringify(doc))).toEqual({ type: 'SNAPSHOT', doc });
    expect(parseRunEvent('snapshot', JSON.stringify({ doc }))).toEqual({ type: 'SNAPSHOT', doc });
  });

  it('各事件翻译成对应 action', () => {
    expect(parseRunEvent('stage', JSON.stringify({ stage: 'codegen', status: 'failed', error: 'e', errorClass: 'verification' }))).toEqual({
      type: 'STAGE', stage: 'codegen', status: 'failed', summary: undefined, result: undefined, error: 'e', errorClass: 'verification',
    });
    expect(parseRunEvent('token', '{"stage":"design","token":"x"}')).toEqual({ type: 'TOKEN', stage: 'design', token: 'x' });
    expect(parseRunEvent('job', '{"status":"completed"}')).toEqual({ type: 'JOB', status: 'completed' });
    expect(parseRunEvent('done', JSON.stringify({ doc }))).toEqual({ type: 'DONE', doc });
    expect(parseRunEvent('pipeline-error', '{"stage":"deploy","message":"m"}')).toEqual({ type: 'PIPELINE_ERROR', stage: 'deploy', message: 'm' });
    expect(parseRunEvent('approval', '{"approval":{"id":"a1"}}')).toEqual({ type: 'APPROVAL_ADDED', approval: { id: 'a1' } });
    expect(parseRunEvent('approval-resolved', '{"id":"a1","decision":"approve"}')).toEqual({ type: 'APPROVAL_REMOVED', id: 'a1' });
  });

  it('数据损坏或事件名未知：返回 null，不抛错', () => {
    expect(parseRunEvent('stage', '{坏掉的 json')).toBeNull();
    expect(parseRunEvent('stage', '')).toBeNull();
    expect(parseRunEvent('whatever', '{}')).toBeNull();
  });
});

class FakeEventSource implements EventSourceLike {
  listeners = new Map<string, (e: { data: string }) => void>();
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  addEventListener(name: string, fn: (e: { data: string }) => void) { this.listeners.set(name, fn); }
  close() { this.closed = true; }
  emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
}

describe('connectRunEvents', () => {
  const setup = () => {
    const es = new FakeEventSource();
    const actions: RunAction[] = [];
    const onSnapshot = vi.fn();
    connectRunEvents(es, { dispatch: (a) => actions.push(a), onSnapshot });
    return { es, actions, onSnapshot };
  };

  it('订阅了全部约定的事件名', () => {
    const { es } = setup();
    expect(Array.from(es.listeners.keys()).sort()).toEqual([...RUN_EVENT_NAMES].sort());
    expect(es.listeners.has('error')).toBe(false); // 不能占用 EventSource 原生的 error 事件
  });

  it('事件按到达顺序转成 action；快照额外触发 onSnapshot（用来重拉审批列表）', () => {
    const { es, actions, onSnapshot } = setup();
    es.emit('snapshot', doc);
    es.emit('token', { stage: 'requirement', token: 'a' });
    es.emit('token', { stage: 'requirement', token: 'b' });
    expect(actions.map((a) => a.type)).toEqual(['SNAPSHOT', 'TOKEN', 'TOKEN']);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it('done 事件：派发 DONE 并主动关闭连接，避免自动重连', () => {
    const { es, actions } = setup();
    es.emit('done', { doc });
    expect(actions.at(-1)).toMatchObject({ type: 'DONE' });
    expect(es.closed).toBe(true);
  });

  it('其它事件不会关闭连接', () => {
    const { es } = setup();
    es.emit('job', { status: 'running' });
    expect(es.closed).toBe(false);
  });

  it('一条损坏的消息被忽略，后面的消息照常处理', () => {
    const { es, actions } = setup();
    es.emit('stage', '{坏掉');
    es.emit('job', { status: 'running' });
    expect(actions).toEqual([{ type: 'JOB', status: 'running' }]);
  });

  it('连接出错：只把「实时连接」标记置为 false，不关闭（EventSource 会自动重连）', () => {
    const { es, actions } = setup();
    es.onerror?.(new Error('x'));
    expect(actions).toEqual([{ type: 'CONNECTION', connected: false }]);
    expect(es.closed).toBe(false);
  });
});
