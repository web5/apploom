# 项目长期记忆：AI 研发平台（AppLoom）

## 一句话定位

> weave your idea into an app.

输入一句话 → AI 多 Agent 流水线自动完成：需求拆解 → 产品原型 → 方案设计 → 代码生成 → 发布上线。

**双重身份（重要）**：既是 AI Agent 学习项目（学习路线 Phase 2 W7/W8），**也是用户三个商业方向里技术适配度最高的实物载体**——龙华区十大行动政策名称写的就是"AI **智能体**与 OPC 协同发展"。求职时它还是"Agent Harness 与评测"的差异化王牌（2026-10-09 拆途游 AI Agent 岗 JD 时定位）。

## 仓库位置与进度现状（2026-10-15 核查）

- **代码仓库**：`~/WorkBuddy/AppLoom/2026-08-12-Phase0骨架搭建/`（git master，托管 web5/apploom.git）
- **项目子目录**：2026-08-12-4Agent流水线补全 / 2026-08-12-Phase0骨架搭建 / 2026-08-12-项目指令咨询 / 2026-09-01-Graph-Ontology引擎融合
- **最新提交**：2026-08-20 `feat(tools): 抽离 Agent 基础能力层 packages/tools`
- **⚠️ 停滞状态**：最后提交 8/20，工作区有 **9 个文件已改未提交**（+333/-41 行），集中在 prototype Agent（`packages/shared/src/prompts/prototype.ts` + `schemas/prototype.ts` 两个新文件未跟踪）。**即第 2 环「产品原型 Agent」开发到一半停了。**
- **资料库镜像页**：https://www.workbuddy.cn/space/d/FKHkwOQDm5aO7s4eZ8ii9X（kind=web）

## 5-Agent 流水线（README 标 5 个全✅，实测第 2 环未完成）

| 环 | Agent | 输入 → 输出 | 实际状态 |
|---|---|---|---|
| 1 | 需求分析 | 一句话 → 结构化 PRD | ✅ |
| 2 | 产品原型 | PRD → 交互原型线框稿 | ⚠️ **开发中未提交** |
| 3 | 架构设计 | PRD+原型 → DesignDocument（技术栈决策者） | ✅ |
| 4 | 代码生成 | Design+原型 → 多文件代码 | ✅ |
| 5 | 部署发布 | Codegen → 部署方案 | ✅ |

**⚠️ README 领先于实现**，别拿README 当进度汇报。

## 关键设计约定（跨会话生效，别推翻）

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

## Agent 基础能力层 packages/tools（2026-08-20，参考 DeepSeek Harness）
- 定位：抽离 Agent 的「手脚」（文件读写/shell/目录列举），为后续 LLM tool-use 打地基。参考 dsh（github.com/deepseek-ai/deepseek-harness）的 Capability Seam 三角色、沙箱三档、追加式日志、审批封闭集合。
- 关键类型：`ToolDefinition`(name/description/inputSchema/minSandbox/handler) + `ToolResult`(ok/output/exitCode/truncated/meta) + `ToolContext`(workspace/sandbox/approver/signal) + `ToolSessionLog`(类型化事件 call/result/error/approval，可重放)。
- 沙箱：三档 read-only / workspace-write / danger-full-access；每个工具声明 minSandbox，会话档位不足拒绝。路径校验两层：字符串级 resolve 前缀（拦 `../`）+ 目标「已存在最长前缀」realpath（拦 symlink 逃逸）。
- 踩坑：macOS `/tmp` 是 `/private/tmp` symlink。第一版 `realpath(workspace)` + 绝对路径未 realpath 导致前缀不一致误判越界。修复：base 不做 realpath。
- 内置 4 工具：read_file(默认16KB截断/拒二进制) / list_dir(depth≤3) / write_file(自动建父目录) / shell(默认120s超时SIGKILL/32KB截断/requiresApproval)。
- 审批接口预留：`Approver` + `requiresApproval`，MVP 缺省放行（不传 approver）；决策封闭集合 allowed-once/rejected/cancelled/unavailable。
- 接入：`LocalDeployService` 的 writeFiles→write_file、runCmd→shell，消除硬编码；保留 checkAndKillPort（系统级端口运维不算 Agent 基础能力）与 dev server detached spawn。
- 下一步（W7 后续）：LLM tool-use 接入（gateway 加 tools 参数 + agentic loop，`registry.toLLMTools()` 已备好）→ codegen 从一次性吐文件升级为「写一批→跑验证→看报错→修」闭环；审批挂到逐步确认流程。
- 设计笔记：`docs/notes/tools.md`。

## 上下文管理方案（2026-09-29 已定稿，未执行）

文档：`~/WorkBuddy/2026-09-29-16-50-26/agent-context-management.md`
- 核心命题：LLM 是无状态纯函数，"记忆"是系统属性不是模型属性 → **状态外置 + 每次调用重建上下文**（Context Engineering）
- 五层栈：L0 指令（吃Prompt Caching）/ L1 会话（滚动窗口）/ **L2 工作（核心，state json）/ L3 检索（每步重算 RAG）/ L4 持久（画像+约定）**
- 单步循环：Assemble → Decide → Execute → Commit → Route（一步一 commit）
- 范式选择：**B（状态机外置）做骨架 + C（计划驱动）做内容**——代码管"走到哪一步"，模型管"这一步干什么"
- 下一步三选一（已定序）：**① 最小 Demo（内存 state + 无 MQ）← 推荐** ② 照方案重构为状态机+异步队列（涉及 `agent_runs` 表迁移与并发风险）③ 先出重构方案 review

## 用户偏好

- 用户 techdog，熟练开发，正在学 AI Agent 开发（项目驱动）
- 重视概念澄清：设计 Agent/提示词时会纠正概念混淆，需区分「平台视角」与「用户产品视角」

## 与用户其他资产的关系（2026-10-12 复盘）

可复用资产盘点中，AppLoom 的定位是：**唯一能证明"Agent 工程化落地能力"的实物**。其他资产：NestJS 微服务 + Vue3 全栈、MCP 网关 + 多厂商 LLM 路由、公众号内容流水线、自建腾讯云（私有化交付能力）。

短板需补（与 AppLoom 无关）：ROI 测算与商业诊断、行业 know-how 速成方法、可复用交付底座（starter kit）、SOW/定价合同。
