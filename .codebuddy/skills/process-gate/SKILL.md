---
name: process-gate
description: 研发流程软 L1 自查。在 AppLoom 等研发项目中写代码前，检查流程凭证是否已产出。适用于无 hook 能力的智能体（pi 等）作为降级路径；有硬 L1 的智能体（CodeBuddy/WorkBuddy/Claude Code/Codex）由 hook 机器强制，本 skill 仅作补充说明。
---

# process-gate · 写码前流程自查（软 L1）

> **你正在 AppLoom 做研发改动。** 如果你的运行环境有 PreToolUse hook（CodeBuddy / WorkBuddy / Claude Code / Codex），硬门已自动生效，你被 deny 时按提示补凭证即可。
> 如果没有 hook（pi 等），**请在写码前主动执行下面 4 道自查**。

## 4 道写码前自查

| # | 你要写什么 | 先要有什么 | 对应门禁 |
|---|---|---|---|
| ① | `apps/web/**/page.tsx`、`features/**`、组件 | **已确认的原型** | B1/B2/B3 · C1 `Proto` |
| ② | `*.service.ts`、`*.controller.ts`、`pipeline/**`、`security/**` | **设计方案** | C2 `Design` · C7 `Plan` |
| ③ | `packages/database/prisma/**`、`packages/shared/src/schemas/**`、`dto.ts` | **契约草案** | C3 `Contract` |
| ④ | `packages/shared/src/prompts/**` | **prompt 变更说明** | C4 `Code`（高危区） |
| ⑤ | 改已有代码 | **改动边界说明** | C4 `Code` |

## 凭证写到哪

| 类型 | 路径 |
|---|---|
| 方案文档 | `docs/plans/*.md`（九子项，走《研发方案与发布规范》） |
| 设计说明 | `docs/notes/**`、`docs/architecture/**` |
| 契约草案 | `docs/api/**`、`specs/**` |
| 原型 | `docs/prototype/**` |

## trailer 写法

commit message 末尾带：

```
Plan: pass
Design: pass
Contract: pass
Proto: pass
Code: pass
Test: pass
```

或指向报告路径：`Plan: docs/plans/xxx.md`（报告头部「阻塞: N」须为 0）。

## 豁免纪律

- 机械改动（重构/类型收敛/零行为变化）→ 在改动说明或文档中记一行「微调豁免」
- 或环境变量 `PROCESS_GATE=off` / `UI_GATE=off`（仅限临时调试）
- **豁免必须可审计**：不许口头豁免、不许只在聊天里说

## 与硬门的关系

| 层 | 谁执行 | 强度 |
|---|---|---|
| **L1 hook** | CodeBuddy / WorkBuddy / Claude Code / **Codex** | 机器强制 deny |
| **L1 skill（本文件）** | 无 hook 的智能体 | 软自查，靠自律 |
| **L2 git hook** | git 本身 | commit 时拦 |
| **L3 CI** | GitHub Actions | PR 兜底，唯一契约 |

**软 L1 失效不会让烂代码进 master（L3 兜底），价值是省返工。**
