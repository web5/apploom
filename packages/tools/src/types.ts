/**
 * AppLoom Agent 基础能力层 —— 类型化工具契约
 *
 * 设计参考 DeepSeek Harness（dsh）：
 *  - Capability Seam 三角色：Definition（本文件的 ToolDefinition）/ Provider（工具实现）/
 *    Consumer（调用方：LLM loop 或 Pipeline 服务）
 *  - 沙箱三档分级：read-only / workspace-write / danger-full-access
 *  - 追加式会话日志：单事件流，可重放、可审计
 *  - 审批机制：敏感操作结果封闭集合（allowed-once / rejected / cancelled / unavailable），
 *    本次仅预留接口（Approver），MVP 缺省放行
 */

/** 沙箱档位（对应 dsh 三档；由低到高） */
export type SandboxLevel = 'read-only' | 'workspace-write' | 'danger-full-access';

/** 沙箱档位顺序（用于比较：required <= actual 才放行） */
const SANDBOX_ORDER: SandboxLevel[] = ['read-only', 'workspace-write', 'danger-full-access'];

/** required 是否满足 actual（actual 档位 >= required 才允许） */
export function sandboxSatisfies(required: SandboxLevel, actual: SandboxLevel): boolean {
  return SANDBOX_ORDER.indexOf(actual) >= SANDBOX_ORDER.indexOf(required);
}

/** 审批决策（dsh 封闭集合） */
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** 审批请求：只描述「这个具体操作」，不含多余上下文 */
export interface ApprovalRequest {
  tool: string;
  /** 人类可读的操作摘要（如 `shell: rm -rf node_modules`） */
  summary: string;
  input: unknown;
}

/** 审批回调；缺省 = 全部放行（MVP）。返回 rejected/cancelled 时工具不执行。 */
export type Approver = (req: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;

/** 工具运行上下文（Provider/Consumer 共享的运行时状态） */
export interface ToolContext {
  /** 工作区根目录：所有相对路径的白名单基准（相当于 dsh 的 workspace） */
  workspace: string;
  /** 当前会话沙箱档位（默认 workspace-write，与 dsh 默认一致） */
  sandbox?: SandboxLevel;
  /** 运行日志回调（供上层收集到 buildLog / SSE） */
  onLog?: (line: string) => void;
  /** 取消信号（超时/用户中止时触发） */
  signal?: AbortSignal;
  /** 审批回调；设置后 requiresApproval 的工具执行前会先询问 */
  approver?: Approver;
  /**
   * 子进程环境变量。设置后 shell 工具只使用它（不再继承 process.env）；缺省沿用 process.env。
   * 执行 LLM 生成的代码（install 脚本 / dev server）时必须显式传入最小环境，避免泄漏 API 进程里的密钥。
   */
  env?: Record<string, string | undefined>;
}

/** 工具结果：结构化为「人类可读 + LLM 可读」的输出，作为反馈循环的输入 */
export interface ToolResult {
  ok: boolean;
  /** 主输出文本（stdout/文件内容等），截断后仍保证前缀完整 */
  output: string;
  /** 输出是否被截断（超出 maxBytes） */
  truncated?: boolean;
  /** shell 等工具的执行退出码 */
  exitCode?: number;
  /** 失败原因（ok=false 时必填） */
  error?: string;
  /** 附加元数据（行数 / 字节数 / 文件列表等） */
  meta?: Record<string, unknown>;
}

/** 工具定义（Capability Seam 的 Definition 角色） */
export interface ToolDefinition<I = unknown, O = ToolResult> {
  /** 唯一名称（snake_case，未来作为 LLM tool calling 的 function name） */
  name: string;
  /** 人类 + LLM 可读描述（喂给模型决定何时调用） */
  description: string;
  /** 输入 JSON Schema（未来喂给 LLM tools 参数声明） */
  inputSchema: Record<string, unknown>;
  /** 所需最低沙箱档位；实际档位不足时拒绝执行 */
  minSandbox: SandboxLevel;
  /** 敏感操作需逐次审批（配合 ctx.approver） */
  requiresApproval?: boolean;
  /** 工具实现 */
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

/** 追加式工具调用日志事件（类型化，可重放，对应 dsh 的 append-only session log） */
export type ToolLogEvent =
  | { type: 'tool_call'; ts: string; tool: string; input: unknown }
  | { type: 'approval'; ts: string; tool: string; decision: ApprovalDecision }
  | { type: 'tool_result'; ts: string; tool: string; ok: boolean; ms: number; output: string }
  | { type: 'tool_error'; ts: string; tool: string; error: string };

/** 不带 ts 的日志事件（append 时自动补时间戳） */
export type ToolLogEventInput =
  | { type: 'tool_call'; tool: string; input: unknown }
  | { type: 'approval'; tool: string; decision: ApprovalDecision }
  | { type: 'tool_result'; tool: string; ok: boolean; ms: number; output: string }
  | { type: 'tool_error'; tool: string; error: string };
