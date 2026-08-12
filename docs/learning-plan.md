# AI Agent 开发学习计划

> 配套项目：AI 研发平台（一句话 → 需求拆解 → 方案设计 → 代码生成 → 发布上线）
> 学习方式：**项目驱动**——每个学习主题都有对应的项目代码任务，边学边写
> 投入节奏：每天 1-2 小时（30 分钟理论 + 60-90 分钟动手）
> 预估周期：10 周

---

## 一、学完你能做到什么

1. **理解 LLM 应用开发全链路**：Prompt → Context → Tool Use → Agent 编排 → 部署
2. **掌握 Agent 核心架构模式**：ReAct、Plan-and-Execute、Multi-Agent、Orchestrator-Workers，并知道什么场景选什么模式
3. **独立完成 Agent 系统**：从单一对话 Agent 到多 Agent 协作流水线
4. **工程化能力**：结构化输出、流式推送、失败重试、成本控制、Agent 评估
5. **交付本项目**：AI 研发平台完整落地，可跑通"一句话上线应用"

---

## 二、知识地图（6 大模块）

```
┌─────────────────────────────────────────────────────────┐
│              AI Agent 开发知识体系                          │
├─────────────────────────────────────────────────────────┤
│ 模块1  LLM 基础 & Prompt Engineering                      │
│        tokens / 上下文窗口 / system-user-assistant 结构    │
│        少样本学习 / CoT 思维链 / Prompt 调优方法论          │
├─────────────────────────────────────────────────────────┤
│ 模块2  结构化输出 & 工具调用                                │
│        JSON 输出约束 / Function Calling / Tool Use       │
│        多工具选择与参数校验 / 工具结果反馈循环               │
├─────────────────────────────────────────────────────────┤
│ 模块3  上下文管理与记忆                                    │
│        Token 预算 / 对话历史截断 / 摘要压缩                │
│        Memory（短期/长期）/ 向量数据库 / Embedding         │
├─────────────────────────────────────────────────────────┤
│ 模块4  Agent 核心架构                                     │
│        ReAct 循环（推理-行动-观察）                        │
│        Plan-and-Execute（计划-执行分离）                  │
│        Multi-Agent 协作（编排/通信/共享状态）               │
│        状态机驱动 Agent 流程                               │
├─────────────────────────────────────────────────────────┤
│ 模块5  Agent 工程化                                       │
│        流式输出（SSE）/ 异步任务 / 进度上报                 │
│        重试与容错 / 幂等 / 超时熔断                        │
│        成本与延迟优化（模型分级、缓存、batch）              │
│        Agent 评估（指标、数据集、回归测试）                 │
├─────────────────────────────────────────────────────────┤
│ 模块6  RAG 与知识增强（进阶）                              │
│        文档切分 / 向量检索 / 混合检索 / 重排序             │
└─────────────────────────────────────────────────────────┘
```

**学习路径顺序**：1 → 2 → 3 → 4 → 5 → 6（模块 6 可在 Phase 3 并行学习）

---

## 三、分阶段学习路线（10 周）

> 每一周 = 1 个学习主题 + 1 个项目任务。**学习主题为项目任务服务**，项目任务反哺知识理解。

### Phase 0：打地基（Week 1-2）

| 周次 | 学习主题 | 项目任务 | 验收标准 |
|------|---------|---------|---------|
| W1 | **LLM 基础 + Prompt Engineering**：token 计费、上下文窗口、system prompt 设计、结构化 Prompt | 搭建 Monorepo（pnpm workspace），配置 PostgreSQL + Prisma，NestJS API 骨架，Next.js 前端骨架 | `pnpm dev` 启动前后端，数据库迁移成功 |
| W2 | **LLM API 实战**：调用 OpenAI/Claude API、温度与参数、流式输出基础、错误处理 | 实现 LLM 网关模块（统一的模型调用封装，支持多 provider），写第一个"你好"对话接口 | 对话接口返回流式响应，可配置模型与 key |

### Phase 1：MVP 跑通（Week 3-4）

| 周次 | 学习主题 | 项目任务 | 验收标准 |
|------|---------|---------|---------|
| W3 | **结构化输出**：JSON Schema 约束、函数调用（Function Calling / Tool Use）基础 | 实现 Requirement Agent（需求拆解→结构化 PRD），前端三栏工作区 | 输入一句话，产出结构化 PRD，前端可展示 |
| W4 | **Agent 第一步：单 Agent 完整闭环** | CodeGen Agent（生成代码）+ Deploy Agent（写入本地并构建），串成单 Agent 简化 Pipeline | "一句话→生成可运行 Web 应用"，端到端跑通 |

### Phase 2：多 Agent 流水线（Week 5-7）

| 周次 | 学习主题 | 项目任务 | 验收标准 |
|------|---------|---------|---------|
| W5 | **Agent 架构模式（上）**：ReAct 循环、工具调用闭环；对比 LangChain/LangGraph、Vercel AI SDK | 加入 Design Agent（架构设计），Pipeline 变 3 Agent | 完整 PRD→方案→代码流水线，中间产出可预览 |
| W6 | **Agent 架构模式（下）**：Multi-Agent 编排（Orchestrator-Workers）、共享状态、Agent 间通信 | Pipeline 升级为 4 Agent（含 SECURITY 安全审查），引入状态机 + 持久化 | 4 Agent 串联，任一节点失败可重试，状态可恢复 |
| W7 | **Agent 工程化**：SSE 流式推送、异步任务队列（Redis BullMQ）、进度上报 | Pipeline 异步化 + 前端流水线看板实时进度，支持逐步确认模式 | 前端实时看到各 Agent 执行进度，可暂停/确认/重试 |

### Phase 3：平台化（Week 8-9）

| 周次 | 学习主题 | 项目任务 | 验收标准 |
|------|---------|---------|---------|
| W8 | **记忆与持久化**：向量库、Embedding、RAG 入门 | 用户系统 + 项目版本管理（每次生成存快照，可回滚） | 用户注册登录，版本历史可回滚 |
| W9 | **Agent 评估与调优**：评估集、质量指标、成本控制（模型分级、缓存） | 模板市场（复用历史项目为模板）+ 对话式修改功能 | 用评估集对比 Prompt 版本效果，模板可从项目创建 |

### Phase 4：产品自修改（Week 10）

| 周次 | 学习主题 | 项目任务 | 验收标准 |
|------|---------|---------|---------|
| W10 | **Agent Runtime & 增量修改**：影响范围分析、Diff、增量生成 | AI Runtime SDK + 产品内嵌 AI 助手，增量修改引擎 | 生成的产品里可直接说"把按钮改蓝色"，AI 修改并发布 |

---

## 四、每日学习节奏（1-2 小时）

```
第 1 段（30 分钟）理论输入
  ├─ 精读 1 篇官方文档/教程（见第五节资源清单）
  └─ 用笔记记录核心概念（推荐在 docs/notes/ 下记，养成输出习惯）

第 2 段（60-90 分钟）项目实战
  ├─ 按当周项目任务写代码
  ├─ 遇到报错 → 用 systematic-debugging 排查（先读报错→假设→验证）
  └─ 每完成一个任务，commit 一次，写清 commit message
```

**关键习惯**：
- **不要跳过动手**：理论看懂 ≠ 会写。每个知识点都要落到项目代码里。
- **先跑通再优化**：MVP 阶段代码丑没关系，先端到端跑通，再重构。
- **每天一个 commit**：保证每天有可见产出，也能随时回退。

---

## 五、核心学习资源

### 官方文档（必读，优先级最高）

| 资源 | 用途 | 学习时机 |
|------|------|---------|
| [Anthropic - Building effective agents](https://www.anthropic.com/research/building-effective-agents) | Agent 架构模式的权威总结 | W5 |
| [Anthropic - Claude function calling 文档](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) | Tool Use 实操 | W3 |
| [OpenAI - Function calling 指南](https://platform.openai.com/docs/guides/function-calling) | Tool Use 实操 | W3 |
| [Vercel AI SDK 文档](https://ai-sdk.dev/docs) | TS 生态 Agent 开发（我们选这个作为主力框架） | W4 |
| [LangGraph.js 文档](https://langchain-ai.github.io/langgraphjs/) | 状态机 Agent 编排（对标参考） | W5-W6 |
| [OpenAI - Prompt engineering 指南](https://platform.openai.com/docs/guides/prompt-engineering) | Prompt 方法论 | W1 |
| [Anthropic - Prompt engineering 课程](https://github.com/anthropics/anthropic-cookbook) | Prompt 实操 | W1 |

### 论文精读（选读，每篇 30 分钟）

| 论文 | 核心观点 | 对应模块 |
|------|---------|---------|
| [ReAct: Synergizing Reasoning and Acting in LLMs](https://arxiv.org/abs/2210.03629) | 推理与行动交织的 Agent 循环 | 模块4 |
| [Reflexion](https://arxiv.org/abs/2303.11366) | 失败后自我反思改进 | 模块5 |
| [Plan-and-Solve Prompting](https://arxiv.org/abs/2305.04091) | 先计划再执行 | 模块4 |
| [Generative Agents](https://arxiv.org/abs/2304.03442) | 记忆与行为的涌现 | 模块3 |
| [Self-RAG](https://arxiv.org/abs/2310.11511) | 按需检索增强 | 模块6 |

### 中文资料（辅助理解）

- 李宏毅《机器学习》LLM 章节（B站）
- 吴恩达《ChatGPT Prompt Engineering for Developers》
- 各大模型厂商中文文档（如 DeepSeek 文档、Kimi 开放平台）

---

## 六、技术选型（本项目）

| 层面 | 选型 | 理由 |
|------|------|------|
| 前端 | React 18 + Next.js 14 + Tailwind CSS | 生态成熟，SSR 适合平台类应用 |
| 后端 | Node.js + NestJS（TypeScript） | 与前端同语言，模块化适合 Agent 流水线 |
| **Agent 框架** | **Vercel AI SDK** + 自研编排层 | 学习 Agent 本质最好轻框架起步，Vercel AI SDK 只提供工具调用/流式能力，编排逻辑自己写，能真正理解内部原理 |
| ORM | Prisma | TS 类型安全，迁移方便 |
| 数据库 | PostgreSQL（生产）/ SQLite（MVP 可选降级） | 见环境说明 |
| 缓存/队列 | Redis + BullMQ | 异步任务、限流 |
| AI 模型 | 主：Claude / GPT 系；副：DeepSeek（代码生成降本） | 多 provider 支持，按任务分级 |

> **环境提醒**：当前机器未装 Docker。MVP 阶段数据库建议用 SQLite（Prisma 一行配置切换）或 Homebrew 装 PostgreSQL，等部署阶段再引入 Docker。详见 `docs/plans/implementation-plan.md`。

---

## 七、项目里程碑（对齐验收）

| 里程碑 | 对应学习周 | 验收标准 |
|--------|-----------|---------|
| M0 基础设施就绪 | W1-2 | Monorepo 可运行，前后端启动，数据库连通 |
| M1 MVP 跑通 | W4 | 输入一句话→生成简单 Web 应用→本地可访问 |
| M2 完整 4-Agent Pipeline | W7 | 需求/方案/代码/安全 4 Agent 串联，异步执行、实时进度、逐步确认 |
| M3 商业化闭环 | W9 | 用户系统、版本管理、模板市场、对话修改 |
| M4 产品自修改 | W10 | 生成的产品内嵌 AI 助手，可对话修改并重新发布 |

---

## 八、学习打卡表

> 每完成一周，勾选并记录心得。建议每周日花 10 分钟回顾。

| 周次 | 主题 | 项目任务 | 完成 | 心得/问题 |
|------|------|---------|------|----------|
| W1 | LLM 基础 + Prompt | 项目骨架 | ☐ | |
| W2 | LLM API 实战 | LLM 网关 | ☐ | |
| W3 | 结构化输出 | 需求 Agent | ☐ | |
| W4 | 单 Agent 闭环 | MVP 流水线 | ☐ | |
| W5 | Agent 架构（上） | 方案 Agent | ☐ | |
| W6 | Agent 架构（下） | 4-Agent 流水线 | ☐ | |
| W7 | Agent 工程化 | 异步 + 进度 | ☐ | |
| W8 | 记忆与 RAG | 版本管理 | ☐ | |
| W9 | 评估与调优 | 模板市场 | ☐ | |
| W10 | Runtime 与增量修改 | AI 助手 SDK | ☐ | |

---

## 九、避坑指南（前辈的经验）

1. **不要把 Agent 想复杂**：一个 LLM + 工具循环 + 状态管理 就是 Agent。框架只是减少样板代码。
2. **Prompt 先行**：换框架前先优化 Prompt。80% 的效果问题出在 Prompt 而非架构。
3. **结构化输出是 Agent 的地基**：Agent 间协作靠的是结构化数据传递，JSON Schema 一定要稳。
4. **成本意识从第一天开始**：每次调用模型前先想"这个任务需要多强的模型？能不能复用结果？"
5. **评估不可缺**：没有评估集的 Agent 系统是"感觉能用"。哪怕只有 20 条用例也好。
6. **多 Agent 慎用**：能用 1 个 Agent 解决就别用 3 个。每个 Agent 都是成本和故障点。
7. **日志是 Agent 调试利器**：记录每步 prompt/response/token，出问题才能回溯。
