# AGENTS.md · AppLoom

> 本文件是 Codex / Claude Code / pi 等智能体在 AppLoom 仓库工作时的入口约定。

## 硬 L1 门禁（必须遵守）

**凡在 AppLoom 写代码，必须启用硬 L1 门禁——写码前机器强制检查流程凭证。**

| 智能体 | 硬 L1 机制 | 配置 |
|---|---|---|
| **Codex（ChatGPT 桌面版）** | PreToolUse hook | `.codex/hooks.json` ← 本仓库已配 |
| **Claude Code** | PreToolUse hook | `.claude/settings.json` |
| **CodeBuddy** | PreToolUse hook | `.codebuddy/settings.json` |
| **WorkBuddy** | 插件 `dev-process-gate` 全局 wrapper | 自动找 `scripts/redline/hook-*.py` |
| 其他无 hook 的 | ⚠️ 降级：软 L1 skill | `.codebuddy/skills/process-gate/SKILL.md` |

**被 deny 时怎么办**：先写凭证文档（`docs/plans/` · `docs/notes/` · `docs/api/` · `specs/` · `docs/prototype/`），再写代码。机械改动可记「微调豁免」。

**Codex 专用提示**：hook 首次使用需在 TUI 里 `/hooks` 信任（或 `codex --dangerously-bypass-hook-trust`）。hook 返回 `permissionDecision: "deny"` 或 exit 2 时会阻断写文件。

规范真源 → `~/AiWorkspace/20-私域资产/研发硬门禁跨智能体规范.md`

## 现有约定（CLAUDE.md）

提交前检查、prompts 不可改等规则见 [CLAUDE.md](CLAUDE.md)。
