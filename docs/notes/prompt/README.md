# 提示词设计笔记

> 项目：AI 研发平台 · AI Agent 开发学习产物
> 关联：学习计划 `docs/learning-plan.md`、设计文档 `docs/plans/ai-dev-platform-design.md`
> 定位：记录本项目 Agent 提示词的设计方法论与草稿，是写代码前的「规范基线」

## 这套笔记的来历

在规划「AI 研发平台」的 Prompt 设计时，先写出了第一版全局 System 基座，里面把**平台自身的技术栈（Next.js / NestJS / Prisma）**写进了所有 Agent 的约束。
复盘时发现这是概念混淆——平台造自己用的技术栈，和用户让 AI 生成的产品用什么技术，是两回事。修正后沉淀为下面这套分层笔记。

## 目录结构（按知识特性分两层）

```
prompt/
├── README.md                  本索引
├── 01-system-base.md          方法论：全局 System 基座（研发流程编排者定位）
├── 02-agent-taxonomy.md       方法论：两类 Agent 区分（平台能力 vs 业务研发）+ 技术栈归属
├── 03-prompt-layers.md        方法论：四层 Prompt 体系 + 通用技巧
└── agents/                    实例：各 Agent 的 Prompt 草稿（项目专属）
    ├── requirement-analyst.md 需求分析 Agent（完整范例）
    ├── architect.md           架构设计 Agent（骨架）
    ├── codegen.md             代码生成 Agent（骨架）
    └── deploy.md              部署发布 Agent（骨架）
```

- **方法论层**（01/02/03）：通用知识，可复用到任何 Agent 项目
- **实例层**（agents/）：本项目专属的 Prompt 草稿，随开发迭代

## 何时更新

- 每设计一个新 Agent → 在 `agents/` 加对应文件
- 每修正一次全局约定（如基座、分类）→ 同步 01/02/03
- 落地写代码时，JSON Schema 契约以 `packages/shared` 内的类型定义为准（见 03 末尾）
