/**
 * write_file —— 在工作区内写入/追加文件
 *
 * 安全：路径必须落在 workspace 内（防 ../../ 越界写盘）；
 * 自动创建父目录（mkdir recursive）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resolveInWorkspace } from '../sandbox';
import { ToolDefinition, ToolResult, ToolContext } from '../types';

export interface WriteFileInput {
  /** 工作区内相对路径 */
  path: string;
  /** 文件内容 */
  content: string;
  /** true = 追加到文件末尾（默认覆盖） */
  append?: boolean;
}

export const WriteFileSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '工作区内相对路径，如 src/App.tsx' },
    content: { type: 'string', description: '完整文件内容（append=false 时覆盖写）' },
    append: { type: 'boolean', description: '是否追加到末尾，默认 false（覆盖）' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
} as const;

export const writeFileTool: ToolDefinition<WriteFileInput> = {
  name: 'write_file',
  description: '在工作区内写入文件（自动创建父目录）。append=false 覆盖，true 追加。返回写入字节数。',
  inputSchema: WriteFileSchema,
  minSandbox: 'workspace-write',
  handler: async (input, ctx: ToolContext) => {
    const target = await resolveInWorkspace(ctx.workspace, input.path);
    const bytes = Buffer.byteLength(input.content, 'utf-8');
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (input.append) await fs.appendFile(target, input.content, 'utf-8');
      else await fs.writeFile(target, input.content, 'utf-8');
    } catch (e) {
      return { ok: false, output: '', error: `写入失败: ${(e as Error).message}` };
    }
    ctx.onLog?.(`[write_file] ${input.path} ${bytes}B ${input.append ? '(append)' : '(overwrite)'}`);
    return { ok: true, output: `已写入 ${input.path}（${bytes} 字节）`, meta: { path: target, bytes } };
  },
};
