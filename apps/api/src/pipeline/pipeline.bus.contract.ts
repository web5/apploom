/**
 * 事件总线契约测试：任何 PipelineEventBus 实现（进程内 / 将来的 Redis 版）都应该通过。
 * 用法：在实现自己的 spec 里 `describeBusContract('名字', () => new XxxBus())`。
 * 异步实现（如 Redis）返回的 Promise 也可以：契约里的断言都用 settle() 等待投递，不依赖同步触发。
 */
import type { PipelineEvent } from './pipeline.types';
import type { PipelineEventBus } from './pipeline.bus';

const tokenEvent = (token: string): PipelineEvent => ({ type: 'token', stage: 'requirement', token });
const settle = () => new Promise((r) => setTimeout(r, 30));
const tokensOf = (events: PipelineEvent[]) => events.map((e) => (e as { token: string }).token);

export function describeBusContract(name: string, make: () => PipelineEventBus | Promise<PipelineEventBus>, cleanup?: (bus: PipelineEventBus) => Promise<void>): void {
  describe(`事件总线契约：${name}`, () => {
    let bus: PipelineEventBus;
    beforeEach(async () => { bus = await make(); });
    afterEach(async () => { await cleanup?.(bus); });

    it('订阅者按顺序收到同一条流水线的事件', async () => {
      const got: PipelineEvent[] = [];
      bus.subscribe('p1', (e) => got.push(e));
      for (const t of ['a', 'b', 'c']) bus.emit('p1', tokenEvent(t));
      await settle();
      expect(tokensOf(got)).toEqual(['a', 'b', 'c']);
    });

    it('流水线之间隔离：不会收到别的流水线的事件', async () => {
      const p1: PipelineEvent[] = [];
      const p2: PipelineEvent[] = [];
      bus.subscribe('p1', (e) => p1.push(e));
      bus.subscribe('p2', (e) => p2.push(e));
      bus.emit('p1', tokenEvent('only-p1'));
      bus.emit('p2', tokenEvent('only-p2'));
      await settle();
      expect(tokensOf(p1)).toEqual(['only-p1']);
      expect(tokensOf(p2)).toEqual(['only-p2']);
    });

    it('多个订阅者都能收到（多个浏览器标签同时看一条流水线）', async () => {
      const a: PipelineEvent[] = [];
      const b: PipelineEvent[] = [];
      bus.subscribe('p1', (e) => a.push(e));
      bus.subscribe('p1', (e) => b.push(e));
      bus.emit('p1', tokenEvent('x'));
      await settle();
      expect([a.length, b.length]).toEqual([1, 1]);
    });

    it('取消订阅后不再收到；取消函数可重复调用；不影响其它订阅者', async () => {
      const kept: PipelineEvent[] = [];
      const dropped: PipelineEvent[] = [];
      bus.subscribe('p1', (e) => kept.push(e));
      const off = bus.subscribe('p1', (e) => dropped.push(e));
      bus.emit('p1', tokenEvent('1'));
      await settle();
      off();
      off();
      bus.emit('p1', tokenEvent('2'));
      await settle();
      expect(tokensOf(dropped)).toEqual(['1']);
      expect(tokensOf(kept)).toEqual(['1', '2']);
    });

    it('没有订阅者时 emit 静默丢弃，不抛错、不影响之后才订阅的人', async () => {
      expect(() => bus.emit('nobody', tokenEvent('lost'))).not.toThrow();
      const got: PipelineEvent[] = [];
      bus.subscribe('nobody', (e) => got.push(e));
      await settle();
      expect(got).toEqual([]);
    });

    it('订阅者自己抛错不应拖垮 emit 调用方（worker 不能因为某个 SSE 连接出错而失败）', async () => {
      bus.subscribe('p1', () => { throw new Error('订阅者炸了'); });
      const ok: PipelineEvent[] = [];
      bus.subscribe('p1', (e) => ok.push(e));
      // 无论实现是同步还是异步投递，emit 本身都必须不抛
      expect(() => bus.emit('p1', tokenEvent('z'))).not.toThrow();
      await settle();
      // 一个订阅者出错也不能让同一事件的其它订阅者收不到
      expect(tokensOf(ok)).toEqual(['z']);
    });

    it('大量订阅者（长时间流式任务 + 多个页面）不触发泄漏告警或丢订阅', async () => {
      const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      const counts = Array.from({ length: 50 }, () => 0);
      const offs = counts.map((_, i) => bus.subscribe('p1', () => { counts[i]++; }));
      bus.emit('p1', tokenEvent('x'));
      await settle();
      offs.forEach((off) => off());
      expect(counts.every((c) => c === 1)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
}
