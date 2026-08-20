/**
 * 沙箱边界：工作区路径白名单 + 档位校验
 *
 * 对应 dsh 的「workspace-write」沙箱：所有文件操作必须落在 workspace 内。
 * 越界（../../etc/passwd、绝对路径绕过）直接抛 SandboxError，不落盘。
 */
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { SandboxLevel, sandboxSatisfies } from './types';

export class SandboxError extends Error {
  constructor(message: string) {
    super(`[sandbox] ${message}`);
    this.name = 'SandboxError';
  }
}

/**
 * 把输入路径解析为 workspace 内的绝对路径。
 *
 * 两步校验：
 *  1. 字符串级：path.resolve 后必须落在 workspace 前缀内（快速拒绝 `../../etc/passwd`）
 *  2. symlink 级：对目标路径「已存在的最长前缀」realpath，确认真实路径仍在 workspace 内
 *     （防 `workspace/link -> /etc` 这类符号链接逃逸）
 *
 * 注意：base 不做 realpath——macOS 上 /tmp 是 /private/tmp 的 symlink，若 base 走 realpath
 * 而输入是绝对路径，两者前缀不一致会误判越界。
 */
export async function resolveInWorkspace(
  workspace: string,
  inputPath: string,
): Promise<string> {
  const base = path.resolve(workspace);
  const target = path.resolve(base, inputPath);
  // 1) 字符串级越界校验
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new SandboxError(`路径越界: ${inputPath}（必须位于 ${base} 内）`);
  }
  // 2) symlink 逃逸校验：目标已存在前缀的 realpath 必须仍在 workspace 内
  const realTarget = await realpathPrefix(target);
  const realBase = await fs.realpath(base).catch(() => base);
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
    throw new SandboxError(`路径越界(symlink): ${inputPath}`);
  }
  return target;
}

/** 从 p 向上找「已存在的最长前缀」并 realpath，不存在的尾部按原样拼回 */
async function realpathPrefix(p: string): Promise<string> {
  let cur = p;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return suffix.length ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) throw new SandboxError(`路径无法解析: ${p}`);
      suffix.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** 校验实际沙箱档位是否满足工具要求 */
export function assertSandboxLevel(required: SandboxLevel, actual: SandboxLevel, tool: string): void {
  if (!sandboxSatisfies(required, actual)) {
    throw new SandboxError(
      `工具 ${tool} 需要 ${required} 档位，当前会话仅 ${actual}（提示词约束不是安全边界，沙箱才是）`,
    );
  }
}

/** 按行截断输出到 maxBytes（保留字节级上限，避免超长输出撑爆上下文） */
export function truncateOutput(text: string, maxBytes = 32 * 1024): { output: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return { output: text, truncated: false };
  // 按 maxBytes 截断并处理多字节边界，保证不产生半截 UTF-8 字符
  let slice = Buffer.from(text, 'utf-8').subarray(0, maxBytes).toString('utf-8');
  // 若末尾是替换符 �（多字节被切断），去掉最后一段不完整字符
  if (slice.endsWith('\uFFFD')) slice = slice.slice(0, -1);
  return { output: `${slice}\n…[输出已截断，共 ${Buffer.byteLength(text, 'utf-8')} 字节，仅展示前 ${maxBytes} 字节]`, truncated: true };
}

/** 探测是否为文本文件（含 NUL 字节或非 UTF-8 解码即视为二进制） */
export function isBinaryBuffer(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  // 解码检查：替换非法序列后若出现大量替换符，视为二进制
  const decoded = buf.toString('utf-8');
  const ratio = (decoded.match(/\uFFFD/g) ?? []).length / Math.max(buf.length, 1);
  return ratio > 0.05;
}
