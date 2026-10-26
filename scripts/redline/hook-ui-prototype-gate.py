#!/usr/bin/env python3
# ============================================================
# hook-ui-prototype-gate.py — PreToolUse 硬阻断：UI 原型门（AppLoom Next.js 适配版）
#
# 写 UI 源码（page.tsx / features 组件）前，须先动过原型 / 页面规格，否则 deny。
# 判定委托 ui_gate_common（失败 fail-open）。
# 协议：stdin JSON → stdout JSON（CodeBuddy / Claude Code / Codex PreToolUse 同构）。
# 开关：UI_GATE=off 可全局关闭。
# ============================================================
import json
import sys

try:
    import ui_gate_common as C
except Exception:
    sys.exit(0)  # fail-open

GATE_MSG = (
    '本次会话尚未修改原型 / 页面规格。写 page.tsx / features 组件前，'
    '请先产出并写入其一：'
    '① 原型文档 docs/prototype/**；'
    '② 页面规格 specs/**/page-spec*.md 或 docs/plans/**；'
    '然后取得用户确认。'
    '确属机械改动（重构/样式收敛/零视觉变化）请记一行「微调豁免」。'
)


def main():
    try:
        payload = C.read_payload()
    except Exception:
        return 0

    tool_name = payload.get('tool_name', '') or ''
    if tool_name not in C.WRITE_TOOLS:
        return 0

    root = C.project_root(payload)
    session_id = payload.get('session_id', '') or ''
    ti = payload.get('tool_input') or {}
    path = C.extract_path(ti)
    if not path:
        return 0

    rel = C.to_rel(path, root)

    if C.is_passport(rel):
        info = {'ts': __import__('time').time(), 'session_id': session_id,
                'files': [rel], 'kind': 'passport'}
        old = C.load_marker(root, session_id)
        if old and C.marker_fresh(old):
            info['files'] = list(set((old.get('files') or []) + [rel]))
        C.save_marker(root, session_id, info)
        C.audit(root, 'passport', tool_name, rel, session_id)
        return 0

    if not C.is_ui_source(rel):
        return 0

    if C.exempt_by_env():
        C.audit(root, 'allow-env-off', tool_name, rel, session_id)
        return 0

    text = C.extract_text(ti)
    if C.EXEMPT_RE.search(text or ''):
        C.audit(root, 'allow-exempt-keyword', tool_name, rel, session_id)
        return 0

    data = C.load_marker(root, session_id)
    if C.marker_fresh(data):
        C.audit(root, 'allow-passport', tool_name, rel, session_id,
                {'passport_files': (data or {}).get('files', [])})
        C.allow_with_context(
            '已过原型凭证（写过 {}）。UI 改动请在 commit message 带 Proto: pass。'.format(
                ', '.join((data or {}).get('files', [])[:3]) or '原型文档')
        )
        return 0

    C.audit(root, 'deny', tool_name, rel, session_id)
    C.deny(GATE_MSG)
    return 0


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass  # fail-open
    sys.exit(0)
