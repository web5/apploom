/**
 * ToolRegistry —— 工具注册表（对应 dsh 的 tools 插件装配）
 *
 * 职责：
 *  - 注册/查询工具定义（Capability Seam 的 Provider 装配点）
 *  - execute()：统一执行管线 = 查工具 → 沙箱档位校验 → 审批 → handler → 记录日志
 *
 * 未来接 LLM tool-use 时：把 tools 的 name/description/inputSchema 序列化成
 * OpenAI 兼容的 tools 参数，execute() 直接作为 function call 的调度入口。
 */
import { ToolDefinition, ToolResult, ToolContext } from './types';
import { ToolSessionLog } from './session-log';
import { assertSandboxLevel } from './sandbox';
import { readFileTool } from './tools/read-file';
import { listDirTool } from './tools/list-dir';
import { writeFileTool } from './tools/write-file';
import { shellTool } from './tools/shell';

/** 注册表内部以宽松类型存放（各工具 input 类型不同，执行时按 any 传参） */
type AnyTool = ToolDefinition<any, any>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly sessionLog: ToolSessionLog;

  constructor(sessionLog?: ToolSessionLog) {
    this.sessionLog = sessionLog ?? new ToolSessionLog();
  }

  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) throw new Error(`工具重复注册: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** 序列化为 LLM tool calling 的 tools 参数（预留） */
  toLLMTools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return [...this.tools.values()].map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  get log(): ToolSessionLog {
    return this.sessionLog;
  }

  /**
   * 统一执行管线：
   *  1. 工具存在性
   *  2. 沙箱档位校验（提示词约束不是安全边界）
   *  3. 审批（requiresApproval && approver 存在时；决策非 allowed-once 则拒绝）
   *  4. 执行 + 计时
   *  5. 追加式日志记录（tool_call / approval / tool_result / tool_error）
   */
  async execute(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, output: '', error: `未知工具: ${name}` };

    const sandbox = ctx.sandbox ?? 'workspace-write';
    this.sessionLog.append({ type: 'tool_call', tool: name, input });
    ctx.onLog?.(`[tool] ${name}`);

    try {
      assertSandboxLevel(tool.minSandbox, sandbox, name);

      if (tool.requiresApproval && ctx.approver) {
        const decision = await ctx.approver({
          tool: name,
          summary: describeCall(tool, input),
          input,
        });
        this.sessionLog.append({ type: 'approval', tool: name, decision });
        if (decision !== 'allowed-once') {
          const reason = decision === 'rejected' ? '被用户拒绝' : decision === 'cancelled' ? '被用户取消' : '审批不可用';
          ctx.onLog?.(`[approval] ${name} → ${decision}`);
          return { ok: false, output: '', error: `${name} ${reason}` };
        }
        ctx.onLog?.(`[approval] ${name} → allowed-once`);
      }

      const start = Date.now();
      const result = await tool.handler(input, ctx);
      const ms = Date.now() - start;
      this.sessionLog.append({ type: 'tool_result', tool: name, ok: result.ok, ms, output: result.output });
      return result;
    } catch (e) {
      const msg = (e as Error).message;
      this.sessionLog.append({ type: 'tool_error', tool: name, error: msg });
      return { ok: false, output: '', error: msg };
    }
  }
}

/** 人类可读的调用摘要（给审批方看） */
function describeCall(tool: AnyTool, input: unknown): string {
  if (tool.name === 'shell') {
    const { command, args, cwd } = (input ?? {}) as { command?: string; args?: string[]; cwd?: string };
    return `shell: ${command} ${(args ?? []).join(' ')}${cwd ? ` (cwd: ${cwd})` : ''}`;
  }
  return `${tool.name}: ${JSON.stringify(input)}`;
}

/** 内置工具集：注册 4 个基础能力，返回可用 registry */
export function createDefaultRegistry(sessionLog?: ToolSessionLog): ToolRegistry {
  return new ToolRegistry(sessionLog)
    .register(readFileTool)
    .register(listDirTool)
    .register(writeFileTool)
    .register(shellTool);
}
