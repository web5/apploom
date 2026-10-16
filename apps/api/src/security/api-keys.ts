/**
 * API Key 认证。API_KEYS 形如 `alice:sk-aaa,ci:sk-bbb`（名字:密钥，名字省略则取密钥前 6 位），未配置 = 不启用认证。
 * 密钥只以 SHA-256 摘要保存在内存里，比较用 timingSafeEqual，避免通过响应时间逐字节猜密钥。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface Principal {
  name: string;
}

interface KeyEntry {
  name: string;
  digest: Buffer;
}

const digestOf = (key: string) => createHash('sha256').update(key).digest();

export function parseApiKeys(raw: string | undefined): KeyEntry[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const i = item.indexOf(':');
      // `name:key`；不含冒号时整段就是密钥
      const [name, key] = i > 0 ? [item.slice(0, i), item.slice(i + 1)] : [item.slice(0, 6), item];
      if (!key) throw new Error(`API_KEYS 里有空密钥: ${JSON.stringify(item)}`);
      return { name, digest: digestOf(key) };
    });
}

/** 逐个比较（不因命中提前返回），耗时与命中位置无关 */
export function authenticate(entries: KeyEntry[], token: string | undefined): Principal | null {
  if (!token) return null;
  const d = digestOf(token);
  let hit: KeyEntry | null = null;
  for (const e of entries) if (timingSafeEqual(e.digest, d)) hit ??= e;
  return hit ? { name: hit.name } : null;
}

/** 取请求里的密钥：Authorization: Bearer / X-API-Key；GET 允许 ?api_key=（浏览器 EventSource 不能带请求头） */
export function extractToken(req: { method?: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, unknown> }): string | undefined {
  const auth = req.headers.authorization;
  const bearer = typeof auth === 'string' ? auth.match(/^Bearer\s+(.+)$/i)?.[1] : undefined;
  const header = req.headers['x-api-key'];
  const fromHeader = bearer ?? (typeof header === 'string' ? header : undefined);
  if (fromHeader) return fromHeader.trim();
  const q = req.query?.api_key;
  return req.method === 'GET' && typeof q === 'string' ? q : undefined;
}
