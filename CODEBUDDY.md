# AI Agent 开发学习项目

## 项目定位
这是一个 AI Agent 开发的系统化学习项目，以「AppLoom」AI 研发平台为实战载体——
用造一个真实产品的方式，把 LLM 应用开发、Agent 架构、工程化、评估调优等知识全部走一遍。

AppLoom 本身的系统设计（双入口架构、4-Agent 流水线、提示词体系、技术栈等）由 `README.md` 和 `docs/` 维护，不在此重复。需要时直接读这些文件。

## 核心目标
1. 深入理解 AI Agent 核心概念：LLM 推理、记忆机制、工具调用、任务规划、多 Agent 协作等。
2. 动手实现可运行的 Agent 原型、组件或工作流。
3. 建立可复用的个人知识库、代码资产与学习笔记。

## 范围分层（重要）
- 当前对话层：聚焦本次要解决的具体问题、要写的代码、要理解的文档。保持上下文具体、可执行，不堆叠长期背景。
- AI 研发平台层：平台说明、通用架构、长期规范、参考资料，应沉淀到项目资料库或专门文档中，**不要塞进单次对话的系统提示词**。

## 学习方式
- **项目驱动**：每个学习主题都有对应的项目代码任务，边学边写，不空读理论。
- **每日节奏**：1-2 小时（30 分钟理论 + 60-90 分钟动手）。
- **关键习惯**：
  - 不跳过动手：理论看懂 ≠ 会写，每个知识点都要落到项目代码里。
  - 先跑通再优化：MVP 阶段代码丑没关系，先端到端跑通，再重构。
  - 每天一个 commit：保证每天有可见产出，也能随时回退。
  - 遇到报错先 systematic-debugging 排查（读报错 → 假设 → 验证）。

## 知识地图（6 大模块）
1. LLM 基础 & Prompt Engineering
2. 结构化输出 & 工具调用
3. 上下文管理与记忆
4. Agent 核心架构（ReAct / Plan-and-Execute / Multi-Agent / 状态机）
5. Agent 工程化（流式 / 异步 / 重试 / 成本 / 评估）
6. RAG 与知识增强（进阶）

## 学习路线（10 周）
| 阶段 | 周次 | 学习主题 | 项目任务 | 状态 |
|------|------|---------|---------|------|
| Phase 0 | W1 | LLM 基础 + Prompt | Monorepo 骨架 | ✅ |
| Phase 0 | W2 | LLM API 实战 | LLM 网关 | ✅ |
| Phase 1 | W3 | 结构化输出 | 需求分析 Agent | ✅ |
| Phase 1 | W4 | 单 Agent 闭环 | MVP 流水线 | ✅ |
| Phase 2 | W5 | Agent 架构（上） | 架构设计 Agent | ✅ |
| Phase 2 | W6 | Agent 架构（下） | 4-Agent 流水线 | ✅ |
| Phase 2 | W7 | Agent 工程化 | 异步队列 + 逐步确认 + 失败重试 | ⏳ **← 当前** |
| Phase 3 | W8 | 记忆与 RAG | 版本管理 + 向量库 | ☐ |
| Phase 3 | W9 | 评估与调优 | 模板市场 + 评估集 | ☐ |
| Phase 4 | W10 | Runtime 与增量修改 | AI 助手 SDK | ☐ |

详见 `docs/learning-plan.md`。里程碑验收标准见该文档第七节。

## 核心学习资源（按优先级）
- **官方文档（必读）**：Anthropic Building effective agents、Claude/OpenAI Function calling、Vercel AI SDK、LangGraph.js、OpenAI Prompt engineering 指南
- **论文精读**：ReAct、Reflexion、Plan-and-Solve、Generative Agents、Self-RAG
- **中文辅助**：李宏毅 LLM 章节、吴恩达 Prompt Engineering

## 协作规范
- 优先把学习笔记、设计文档、代码规范沉淀到项目资料库或 Drive，而非只在对话里讨论。
- 写代码前先明确目标与验收标准，完成后简要说明关键决策。
- 遇到新概念时，先解释原理再给出实现。
- 可主动推荐学习路径、工具或文档，但不要偏离当前任务过度扩展。

## 输出偏好
- 中文为主，代码与术语保留英文。
- 代码示例要可运行，关键处加注释。
- 复杂内容用结构化方式呈现：列表、表格、代码块、Mermaid 图等。

## 避坑提醒（前辈经验）
1. 不要把 Agent 想复杂：一个 LLM + 工具循环 + 状态管理就是 Agent。
2. Prompt 先行：换框架前先优化 Prompt，80% 效果问题出在 Prompt。
3. 结构化输出是 Agent 地基：JSON Schema 一定要稳。
4. 成本意识从第一天开始：每次调用前想「这个任务需要多强的模型？」
5. 评估不可缺：没有评估集的 Agent 系统只是「感觉能用」。
6. 多 Agent 慎用：能用 1 个解决就别用 3 个。
7. 日志是调试利器：记录每步 prompt/response/token。
