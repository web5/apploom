/**
 * 产物指纹：对「值」做稳定序列化后取 SHA-256 前 16 位。
 *
 * 指纹要回答的是「内容有没有变」，所以语义相同的两份产物必须得到同一个指纹：
 *  - 对象 key 排序（字段顺序不同不算变）
 *  - 与 JSON 一致地处理 undefined（对象里的 undefined 字段等同于不存在；数组里的 undefined 与 null 同）
 *  - -0 归一为 0；NaN / Infinity 与 JSON 一致序列化为 null
 *  - 数组顺序有意义（不排序）
 * 出现环引用直接抛错：流水线产物是纯 JSON 数据，有环说明上游出了问题，不能静默产出一个不稳定的指纹。
 */
import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  return stringify(value, new Set());
}

function stringify(value: unknown, path: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    case 'bigint':
      return JSON.stringify(value.toString());
    default:
      break;
  }
  const obj = value as object;
  if (path.has(obj)) throw new Error('产物含环引用，无法计算指纹');
  path.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map((v) => stringify(v, path)).join(',')}]`;
    const rec = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(rec).sort()) {
      const v = rec[k];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      parts.push(`${JSON.stringify(k)}:${stringify(v, path)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    path.delete(obj);
  }
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}
