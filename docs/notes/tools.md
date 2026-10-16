# Agent 基础能力层（packages/tools）设计笔记

> W7 Agent 工程化 · 子任务：把 Agent 的「手脚」——文件读写、shell 执行、目录列举——从
> 业务代码里抽离成可复用、可审计、可接 LLM tool-use 的工具层。
> 设计参考：DeepSeek Harness（`github.com/deepseek-ai/deepseek-harness`）。

## 1. 为什么做这层

改造前，AppLoom 的 Agent「没有手脚」：

- **codegen Agent** 一次性把全部文件吐进 JSON（`files[]`），无法先写一部分、跑一下验证、再改；
- **deploy 阶段** 唯一用到文件写入/命令执行，但能力硬编码在 `LocalDeployService` 里
  （`writeFiles` + `runCmd`），耦合、不可复用、没有给 LLM 的通路。

我们要的是 dsh 的那句定位：

> **agent = 模型 + 执行框架**。模型是灵魂，执行框架让 Agent 感知环境、调用工具、持续行动。

## 2. 参考 dsh 抄了什么、舍了什么

| dsh 设计 | AppLoom 落地 | 说明 |
|---------|-------------|------|
| Capability Seam 三角色（Definition / Provider / Consumer） | `ToolDefinition`（定义）/ 各 `tools/*.ts`（实现）/ `ToolRegistry.execute`（调度） | 类型的定义/实现/调用分离，后续可让第三方注册工具 |
| 沙箱三档 `read-only / workspace-write / danger-full-access` | `SandboxLevel` + `sandboxSatisfies` | 每个工具声明 `minSandbox`，会话档位不足拒绝执行 |
| workspace-write 默认档位 | `ToolContext.sandbox` 默认 `workspace-write` | 与 dsh 默认一致 |
| 路径白名单（工作区根） | `resolveInWorkspace`：字符串级校验 + symlink realpath 校验 | 防 `../../etc/passwd` 与 `workspace/link -> /etc` 逃逸 |
| 追加式会话日志（可重放） | `ToolSessionLog`（类型化事件：call/result/error/approval） | 未来可作审计、恢复、分叉 |
| 逐次审批（allowed-once / rejected / cancelled / unavailable） | `Approver` 接口 + `requiresApproval` | **已接入**（`apps/api/src/approval/`）：`ApprovalService.approverFor()` 按策略判定——白名单命令放行、破坏性命令无条件拒绝、可疑命令挂起等人审批（带超时，超时=拒绝）；SSE `approval` 事件 + `POST /pipeline/:id/approvals/:aid` 决策。不传 approver 的裸调用仍放行 |
| 工具结果反馈循环 | `ToolResult`（ok/output/exitCode/error/meta） | 已结构化，待 LLM tool-use 接入后直接回传模型 |
| 一切皆插件（Cordis） | 极简版：`ToolRegistry.register()` 注册表 | 不引 Cordis——20 行的 Map 注册表对当前规模足够，不过度设计 |
| 命令输出截断（上下文即金钱） | `truncateOutput`（read 16KB / shell 32KB，可配） | 防超长输出撑爆上下文与 token 成本 |

## 3. 核心类型（一次看懂）

```ts
// 工具定义 = 模型「看得见的说明书」+ 真实实现
interface ToolDefinition {
  name: string;            // 如 write_file / shell（snake_case，未来即 function name）
  description: string;     // 给 LLM 决定何时调用
  inputSchema: JSONSchema; // 给 LLM 的 tools 参数声明（未来）
  minSandbox: SandboxLevel;
  handler: (input, ctx) => Promise<ToolResult>;
}

// 执行上下文 = 一次调用共享的运行时状态
interface ToolContext {
  workspace: string;    // 路径白名单基准
  sandbox?: SandboxLevel;
  approver?: Approver;  // 审批回调（本期预留）
  signal?: AbortSignal; // 取消
}

// 结果 = 反馈循环的输入
interface ToolResult {
  ok: boolean;
  output: string;        // stdout / 文件内容 / 提示，人类与 LLM 同读
  exitCode?: number;
  truncated?: boolean;   // 截断标记
  meta?: {...};          // 行数 / 字节数 / 目录清单等
}
```

## 4. 内置 4 个工具

| 工具 | 功能 | minSandbox | 安全点 |
|------|------|-----------|--------|
| `read_file` | 读文本文件前 N 字节 | read-only | 二进制文件拒绝返回原文（防污染上下文）；默认 16KB 截断 |
| `list_dir` | 列目录（有限递归 depth≤3） | read-only | 防递归 node_modules 失控 |
| `write_file` | 写入/追加文件 | workspace-write | 自动建父目录；路径白名单内 |
| `shell` | 执行命令 | workspace-write | 强制 timeout（默认 120s，超时 SIGKILL）；cwd 白名单；输出 32KB 截断；`requiresApproval` 预留审批 |

## 5. 沙箱两层校验（为什么这样写）

macOS 的 `/tmp` 是 `/private/tmp` 的符号链接，这坑了我们一次：

- 第一版：`realpath(workspace)` 得到 `/private/tmp/...`，但输入绝对路径 `/tmp/...` 未 realpath，
  前缀对不上 → 把正常操作误判为越界。
- 修复：base 不做 realpath，字符串级校验（拦 `../`）+ 对目标「已存在最长前缀」realpath
  （拦 symlink 逃逸）两层结合，既放行 `/tmp` 场景，又挡 `workspace/link -> /etc`。

```ts
const base = path.resolve(workspace);          // 不做 realpath
const target = path.resolve(base, inputPath);  // 1) 字符串级
if (!target.startsWith(base + sep)) throw ...;
const realTarget = await realpathPrefix(target); // 2) symlink 级
if (!realTarget.startsWith(realBase + sep)) throw ...;
```

> 注：当前 shell 工具没做 bwrap/Seatbelt 级系统隔离（dsh 有），依赖路径白名单 + timeout。
> 生产化方向：Linux 用 bwrap/Landlock，macOS 用 Seatbelt——与 dsh 同路线。

## 6. 接入现状：LocalDeployService 重构

- `writeFiles` → `tools.execute('write_file', ...)`（循环写）
- `runCmd` → `tools.execute('shell', { command, args, cwd, timeoutMs, maxOutputBytes })`
- 保留本地实现：`checkAndKillPort`（系统级端口运维，不属于 Agent 基础能力）、dev server 的
  detached spawn（后台长驻进程，不属于同步工具调用）

一处行为差异：原 `runCmd` 收集完整日志，shell 工具默认截断 32KB；install 场景传
`maxOutputBytes: 1MB` 保持 buildLog 完整。

## 7. 下一步（留给 W7 后续）

1. **LLM tool-use 接入**：网关加 `tools` 参数 → agentic loop（模型发起 tool_call →
   `registry.execute` → 结果回传 → 继续），codegen Agent 从「一次性吐文件」升级为
   「写一批 → 跑验证 → 看报错 → 修」的真实研发闭环。`toLLMTools()` 已备好。
2. **审批接入**：把 `Approver` 挂到现有逐步确认（waiting_confirm）流程，shell 敏感操作逐次询问。
3. **工具扩展**：网络请求（fetch）、包搜索（npm search）等，按需注册即可，不动核心。
4. **会话恢复**：`ToolSessionLog` 落盘后，支持从某次调用「分叉」重跑（dsh 的 trajectory view 思路）。
