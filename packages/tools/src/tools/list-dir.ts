/**
 * list_dir —— 列举工作区内目录内容
 *
 * 支持有限递归（depth 上限 3，防止模型请求列整个 node_modules 时失控）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resolveInWorkspace } from '../sandbox';
import { ToolDefinition, ToolResult, ToolContext } from '../types';

export interface ListDirInput {
  /** 工作区内目录路径（默认工作区根） */
  path?: string;
  /** 递归深度（默认 1 = 仅当前层；上限 3） */
  depth?: number;
}

export const ListDirSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '目录路径，默认工作区根' },
    depth: { type: 'number', description: '递归深度，默认 1，上限 3' },
  },
  additionalProperties: false,
} as const;

const MAX_DEPTH = 3;

interface Entry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
}

async function walk(dir: string, depth: number): Promise<Entry[]> {
  const names = await fs.readdir(dir);
  const entries: Entry[] = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue; // 文件被并发删除等，跳过
    }
    if (stat.isDirectory()) {
      entries.push({ name, type: 'dir' });
      if (depth > 1) {
        const children = await walk(abs, depth - 1);
        // 缩进表示层级
        entries.push(...children.map((c) => ({ ...c, name: `${name}/${c.name}` })));
      }
    } else {
      entries.push({ name, type: 'file', size: stat.size });
    }
  }
  return entries;
}

export const listDirTool: ToolDefinition<ListDirInput> = {
  name: 'list_dir',
  description: '列举工作区内目录内容。返回文件/子目录清单与大小，支持有限递归（最多 3 层）。',
  inputSchema: ListDirSchema,
  minSandbox: 'read-only',
  handler: async (input, ctx: ToolContext) => {
    const depth = Math.max(1, Math.min(input.depth ?? 1, MAX_DEPTH));
    const target = await resolveInWorkspace(ctx.workspace, input.path ?? '.');
    let entries: Entry[];
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) return { ok: false, output: '', error: `${input.path} 不是目录` };
      entries = await walk(target, depth);
    } catch (e) {
      return { ok: false, output: '', error: `列举失败: ${(e as Error).message}` };
    }

    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    const lines = entries.map((e) => {
      const size = e.type === 'file' ? ` (${e.size}B)` : '/';
      return `${e.type === 'dir' ? '[DIR]' : '[FILE]'} ${e.name}${size}`;
    });
    const dirs = entries.filter((e) => e.type === 'dir').length;
    const files = entries.filter((e) => e.type === 'file').length;
    ctx.onLog?.(`[list_dir] ${target} → ${dirs} 目录 ${files} 文件 (depth=${depth})`);
    return {
      ok: true,
      output: lines.length ? lines.join('\n') : '（空目录）',
      meta: { path: target, dirs, files, truncated: lines.length > 200 },
    };
  },
};
