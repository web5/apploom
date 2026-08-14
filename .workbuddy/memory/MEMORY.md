# 项目长期记忆：AI 研发平台

## 关键设计约定（跨会话生效）

### Agent 提示词设计：两类 Agent 区分（重要）
- **全局 System 基座**定位为「研发流程编排者」，只注入研发流程方法论（需求→方案→代码→发布 各阶段定义/交接契约/MVP 优先），**绝不预设任何技术栈**。
- 区分两类 Agent：
  - **Platform 类（平台能力 Agent）**：面向平台自身功能，才绑定平台技术栈（Next.js/NestJS/Prisma）。
  - **Product 类（业务研发 Agent）**：面向用户要造的产品，不绑技术栈。
- 本项目的 4 个核心 Agent（需求分析/架构设计/代码生成/部署发布）**全部是 Product 类**。
- **技术栈归属**：全局基座不出现；架构设计 Agent 自己输出 `techStack` 字段（它是决策者）；代码生成 Agent 读取它写「用户产品」代码。
- 踩坑记录：第一版基座误把平台技术栈塞进全局约束，被用户指出「研发平台不应限制用户产品技术栈」。

### 提示词笔记已沉淀
- 目录 `docs/notes/prompt/`：README(索引) + 01-system-base + 02-agent-taxonomy + 03-prompt-layers + agents/(4个Agent草稿)
- 后续写 Agent Prompt / 加新 Agent 时，先同步这里；JSON Schema 契约落地在 `packages/shared`。

### 系统双入口架构（重要，2026-08-12 用户敲定）
系统分两个入口/门户，职责严格分离：
- **管理端（Admin Portal）**：管理和维护 AI 能力本身。包含：提示词调试、MCP 配置、记忆管理、Skills 配置与调试、Agent/Schema 契约维护。当前 `/debug` 属于此端（提示词调试工作台）。
- **生产端（Production Portal）**：用 AI 能力做真实研发作业。即 4-Agent 流水线（需求→方案→代码→部署），含"下一步"推进、项目版本、模板市场、发布管理。
- 关键区分：「下一步 → 方案设计」属于**生产端**，不在调试页；调试页只管调好单个 Agent 的 Prompt/Schema，调好的能力被生产端消费。
- 路由建议：管理端 `/admin/*`，生产端 `/studio/*`（或根 `/` 进工作台）。

## 技术栈决策
- 平台本身：TypeScript（Next.js 14 + NestJS 11 + Prisma + PostgreSQL）
- LLM 网关：OpenAI 兼容适配层（DeepSeek + 混元 hy3），多 provider
- 数据库：本机 Postgres.app（无 Docker）
- Redis：已装（W7，源码编译 redis-7.4.10 → `~/.local/redis/bin/`，无 Homebrew；daemon 跑 6379，数据目录 `/tmp/apploom-redis`），用于 BullMQ 异步任务队列

## W7 Agent 工程化关键架构（2026-08-14 完成，跨会话重要）
- **链式 BullMQ job 设计**：每阶段一个独立 job（`pipeline:doc:{id}` 是唯一事实来源，状态存 Redis）。为什么不用「单 job 跑全流水线 + 进程内等待确认」？BullMQ job 锁 30s 检测，无限等待确认会触发 `job stalled` → failed。
- **逐步确认**：阶段 job 完成后正常结束（不占队列），挂起状态只存在 Redis doc；`POST /confirm` 入队下一阶段 job。
- **幂等交接**：`doc.handoffs[stage]` 标记「已完成交接」，job 崩溃重复执行直接跳过，避免链式重复入队；`maxStalledCount: 2`。
- **断点续跑**：重试/崩溃后按 doc 状态续跑（上游产出保留），BullMQ job 只带 `{docId, stage}` 轻量数据。
- **PipelineBus（EventEmitter）**：Worker 与 NestJS API 同进程，SSE token 级推送走进程内事件而非 Redis Pub/Sub。
- **SSE 事件名**：业务错误用 `pipeline-error`，避开 EventSource 原生 `error` 连接事件冲突。
- **BullMQ 坑**：队列名不能含 `:`；ioredis 需 `maxRetriesPerRequest: null`。
- **前端**：Studio 用 EventSource 订阅 SSE（走 next rewrites `/api/*`），sessionStorage 存最近 pipeline id 支持刷新恢复；React 18 批处理下 token 累加用函数式 setState。
- 验收：自动模式 4 阶段 completed、逐步确认挂起/放行、失败重试断点续跑 均已端到端验证。

## 用户偏好
- 用户 techdog，熟练开发，正在学 AI Agent 开发（项目驱动）
- 重视概念澄清：设计 Agent/提示词时会纠正概念混淆，需区分「平台视角」与「用户产品视角」
