/**
 * 固定窗口限流（进程内）。多实例部署时各实例各算各的，要全局限流需换成 Redis 计数——此处先满足单实例。
 */
export interface LimitResult {
  allowed: boolean;
  /** 被拒绝时，距窗口重置还有多少秒 */
  retryAfterSec: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, limit: number, windowMs = 60_000): LimitResult {
    if (limit <= 0) return { allowed: true, retryAfterSec: 0 };
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return { allowed: true, retryAfterSec: 0 };
    }
    w.count += 1;
    if (w.count > limit) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)) };
    return { allowed: true, retryAfterSec: 0 };
  }

  /** 清掉已过期的窗口，防止 key 越积越多（如被扫描时的海量 IP） */
  sweep(windowMs = 60_000): number {
    const t = this.now();
    let n = 0;
    for (const [k, w] of this.windows) {
      if (t - w.start >= windowMs) {
        this.windows.delete(k);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.windows.size;
  }
}
