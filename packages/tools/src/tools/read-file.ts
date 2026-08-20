/**
 * read_file —— 读取工作区内文本文件
 *
 * 安全：路径必须落在 workspace 内；二进制文件拒绝返回原文（防污染上下文）；
 * 超大文件默认只读前 16KB 并标记截断（成本意识：上下文即金钱）。
 */
import { promises as fs } from 'node:fs';
import { isBinaryBuffer, resolveInWorkspace, truncateOutput } from '../sandbox';
import { ToolDefinition, ToolResult, ToolContext } from '../types';

export interface ReadFileInput {
  /** 工作区内相对路径（或 workspace 前缀的绝对路径） */
  path: string;
  /** 字节偏移（默认 0） */
  offset?: number;
  /** 读取字节上限（默认 16KB，防超长文件撑爆上下文） */
  maxBytes?: number;
}

export const ReadFileSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '工作区内相对路径，如 src/App.tsx' },
    offset: { type: 'number', description: '字节偏移，默认 0' },
    maxBytes: { type: 'number', description: '读取字节上限，默认 16384' },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

export const readFileTool: ToolDefinition<ReadFileInput> = {
  name: 'read_file',
  description: '读取工作区内文本文件的前 N 字节。返回内容、总字节数、总行数；二进制文件会拒绝返回原文。',
  inputSchema: ReadFileSchema,
  minSandbox: 'read-only',
  handler: async (input, ctx: ToolContext) => {
    const target = await resolveInWorkspace(ctx.workspace, input.path);
    const maxBytes = input.maxBytes ?? 16 * 1024;
    const offset = input.offset ?? 0;

    let buf: Buffer;
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) return { ok: false, output: '', error: `${input.path} 不是普通文件` };
      buf = await fs.readFile(target);
    } catch (e) {
      return { ok: false, output: '', error: `读取失败: ${(e as Error).message}` };
    }

    if (isBinaryBuffer(buf)) {
      return {
        ok: false,
        output: '',
        meta: { totalBytes: buf.length, binary: true },
        error: `${input.path} 是二进制文件（${buf.length} 字节），已拒绝返回原文`,
      };
    }

    const text = buf.toString('utf-8');
    const totalBytes = buf.length;
    const totalLines = text.split('\n').length;
    const sliced = text.slice(offset);
    const { output, truncated } = truncateOutput(sliced, maxBytes);
    ctx.onLog?.(`[read_file] ${input.path} ${totalBytes}B/${totalLines}行 offset=${offset}${truncated ? ' (截断)' : ''}`);
    return {
      ok: true,
      output,
      truncated,
      meta: { path: target, totalBytes, totalLines, binary: false },
    };
  },
};
