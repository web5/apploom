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

## 技术栈决策
- 平台本身：TypeScript（Next.js 14 + NestJS 11 + Prisma + PostgreSQL）
- LLM 网关：OpenAI 兼容适配层（DeepSeek + 混元 hy3），多 provider
- 数据库：本机 Postgres.app（无 Docker）；Redis 待 Phase1 后期 Homebrew 装

## 用户偏好
- 用户 techdog，熟练开发，正在学 AI Agent 开发（项目驱动）
- 重视概念澄清：设计 Agent/提示词时会纠正概念混淆，需区分「平台视角」与「用户产品视角」
