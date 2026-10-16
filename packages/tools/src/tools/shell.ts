/**
 * shell —— 在工作区内执行 shell 命令
 *
 * 安全边界（对齐 dsh 的 workspace-write 沙箱）：
 *  - cwd 必须落在 workspace 内（默认工作区根）
 *  - 强制超时（默认 120s），超时 SIGKILL
 *  - 输出按 maxOutputBytes 截断（默认 32KB），防超长日志撑爆上下文
 *  - 声明 requiresApproval：若上层注入 approver，执行前会先询问（dsh 逐次审批）；
 *    MVP 缺省无 approver = 放行
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolveInWorkspace, truncateOutput } from '../sandbox';
import { ToolDefinition, ToolResult, ToolContext } from '../types';

export interface ShellInput {
  /** 可执行命令（如 npm / node / sh） */
  command: string;
  /** 参数列表（含 shell 元字符的命令请用 ["-c", "完整命令"]，避免注入） */
  args?: string[];
  /** 工作目录（默认工作区根；必须位于 workspace 内） */
  cwd?: string;
  /** 超时毫秒（默认 120000） */
  timeoutMs?: number;
  /** 输出截断字节上限（默认 32KB） */
  maxOutputBytes?: number;
}

export const ShellSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: '可执行命令，如 npm / node / sh' },
    args: { type: 'array', items: { type: 'string' }, description: '参数列表；含管道/重定向请用 ["-c", "完整命令"]' },
    cwd: { type: 'string', description: '工作目录，默认工作区根' },
    timeoutMs: { type: 'number', description: '超时毫秒，默认 120000' },
    maxOutputBytes: { type: 'number', description: '输出截断上限，默认 32768' },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

/** 杀掉整个进程组（负 pid）；失败（进程已退出等）时退化为只杀直接子进程 */
function killTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

export const shellTool: ToolDefinition<ShellInput> = {
  name: 'shell',
  description: '在工作区内执行 shell 命令。返回退出码与合并的 stdout/stderr（超长自动截断）。含管道/重定向等组合命令时用 ["-c", "命令"]。',
  inputSchema: ShellSchema,
  minSandbox: 'workspace-write',
  requiresApproval: true,
  handler: async (input, ctx: ToolContext) => {
    const cwd = await resolveInWorkspace(ctx.workspace, input.cwd ?? '.');
    try {
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) return { ok: false, output: '', error: `${input.cwd} 不是目录` };
    } catch (e) {
      return { ok: false, output: '', error: `cwd 不存在: ${(e as Error).message}` };
    }

    const timeoutMs = input.timeoutMs ?? 120_000;
    const maxOutputBytes = input.maxOutputBytes ?? 32 * 1024;

    return new Promise<ToolResult>((resolve) => {
      const launch = ctx.wrap ? ctx.wrap({ command: input.command, args: input.args ?? [] }) : { command: input.command, args: input.args ?? [] };
      // detached：子进程自成进程组，超时 / 中止时才能连孙进程（npm 脚本里起的后台进程）一起杀掉
      const child = spawn(launch.command, launch.args, {
        cwd,
        shell: false,
        detached: true,
        env: { ...(ctx.env ?? process.env), CI: '1', ADBLOCK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      let exited = false;
      let killedByTimeout = false;

      const timer = setTimeout(() => {
        killedByTimeout = true;
        killTree(child);
      }, timeoutMs);

      const onAbort = () => {
        if (!exited) killTree(child);
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (b) => (out += b.toString()));
      child.stderr?.on('data', (b) => (out += b.toString()));
      child.on('error', (e) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        exited = true;
        ctx.onLog?.(`[shell] ${input.command} ✕ ${e.message}`);
        resolve({ ok: false, output: out, error: `启动失败: ${e.message}` });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        exited = true;
        const { output, truncated } = truncateOutput(out, maxOutputBytes);
        ctx.onLog?.(`[shell] $ ${[input.command, ...(input.args ?? [])].join(' ')} → exit=${code ?? 'null'} (${out.length}B${truncated ? ' 截断' : ''})`);
        if (killedByTimeout) {
          resolve({ ok: false, output, truncated, exitCode: code ?? 1, error: `命令超时（${timeoutMs / 1000}s），已 SIGKILL: ${input.command}` });
        } else {
          resolve({ ok: code === 0, output, truncated, exitCode: code ?? 1 });
        }
      });
    });
  },
};
