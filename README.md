# AppLoom

> weave your idea into an app.
>
> 输入一句话，AI 多 Agent 流水线自动完成：需求拆解 → 产品原型 → 方案设计 → 代码生成 → 发布上线

AppLoom 是一个 AI 研发平台，也是 AI Agent 开发的实战项目。核心是一个 5-Agent 编排引擎，把模糊想法逐阶段细化为可运行应用。

## 双入口架构

系统分两个入口，职责严格分离：

| 入口 | 路由 | 职责 |
|------|------|------|
| **生产端 · Studio** | `/studio` | 用 AI 能力做真实研发作业：5-Agent 流水线、逐阶段推进与确认、项目版本、模板市场、发布 |
| **管理端 · Admin** | `/admin/*` | 维护 AI 能力本身：提示词调试、MCP/记忆/Skills 配置、Agent 与 Schema 契约维护 |

- 当前 `/admin/debug`：提示词调试工作台（流式 + Zod 校验 + 调试摘要）
- 当前 `/studio`：5 阶段流水线（需求拆解 → 产品原型 → 方案设计 → 代码生成 → 部署发布），「下一步」推进

## 5 个核心 Agent（全部 Product 类，不预设技术栈）

| Agent | 流程位置 | 输入 → 输出 | 状态 |
|-------|---------|-----------|------|
| 需求分析 | 第 1 环 | 一句话 → 结构化 PRD | ✅ |
| 产品原型 | 第 2 环 | PRD → 交互原型线框稿（页面布局 + 交互流程，供确认 UI） | ✅ |
| 架构设计 | 第 3 环 | PRD + 原型 → DesignDocument（技术栈决策者） | ✅ |
| 代码生成 | 第 4 环 | Design + 原型 → 多文件代码（files + dependencies + runCommand） | ✅ |
| 部署发布 | 第 5 环 | Codegen → 部署方案（URL + 构建日志） | ✅ |

> 设计原则：全局 System 基座只注入研发流程方法论，**不预设任何技术栈**；技术栈由架构设计 Agent 按场景决策。详见 `docs/notes/prompt/`。

## 技术栈

- 平台本身：TypeScript · Next.js 14 · NestJS 11 · Prisma · PostgreSQL
- LLM 网关：OpenAI 兼容适配层（DeepSeek + 腾讯混元 hy3），多 provider
- Monorepo：pnpm workspace

## 目录结构

```
apploom/
├── apps/
│   ├── web/          Next.js 14（/ 入口 · /studio 生产 · /admin 管理端）
│   └── api/          NestJS（SSE 流式 Agent 接口）
├── packages/
│   ├── shared/       共享类型 + Zod Schema + Agent System Prompt
│   ├── llm/          LLM 网关（OpenAI 兼容，流式 + json_object 结构化输出）
│   └── database/     Prisma + PostgreSQL
└── docs/
    ├── notes/prompt/     提示词设计笔记（方法论 + 4 Agent 草稿）
    ├── plans/            设计文档 + 实施计划
    ├── prototype/        静态原型稿（7 页面）
    └── learning-plan.md  AI Agent 学习计划
```

## 本地启动

```bash
# 1. 安装依赖
pnpm install

# 2. 配置 LLM key（.env 已 gitignore）
cp .env.example .env
# 填入 DEEPSEEK_API_KEY 或 HUNYUAN_API_KEY

# 3. 一次性构建（shared/llm 产出 dist，api 才能在 node 运行）
pnpm -r build

# 4. 两个终端分别启动
pnpm --filter api start      # http://localhost:3001
pnpm --filter web dev        # http://localhost:3000

# 5. 浏览器打开
open http://localhost:3000          # 入口
open http://localhost:3000/studio   # 生产端
open http://localhost:3000/admin/debug  # 提示词调试
```

### 端口

Studio `3000`、API `3001`、Redis `6379`、Postgres `5432`；平台生成的产物站点从 **18000** 起由平台自动分配（`DEPLOY_BASE_PORT` 可改）。完整划分与选型理由见 [docs/ports.md](docs/ports.md)。

## 调试提示词

改 `packages/shared/src/prompts/*.ts` 后重跑：

```bash
pnpm --filter @apploom/shared build && pnpm debug:prd "一句话需求"
```

或直接在 `/admin/debug` 页面交互式调试：流式输出、Zod 校验、P0/假设数摘要、纯重跑测稳定性、补充指令迭代。

## 学习路线

本项目也是 AI Agent 开发学习载体，按周推进（W1-W10）：

- **W1-W2** LLM 基础 + API 实战（✅ 已完成 Monorepo + LLM 网关）
- **W3-W4** 结构化输出 + 单 Agent 闭环（✅ 需求分析 Agent + 调试工作台）
- **W5-W6** 多 Agent 流水线（✅ 4-Agent 全部实现：需求 → 设计 → 代码生成 → 部署发布）
- **W7** Agent 工程化（⏳ 异步任务队列、逐步确认、失败重试）
- **W8-W9** 记忆/RAG + 评估调优
- **W10** Agent Runtime + 增量修改

详见 `docs/learning-plan.md`。

## License

MIT
