#!/usr/bin/env python3
# ============================================================
# ui_gate_common.py — UI 门共享判定（AppLoom Next.js 适配版）
#
# 与 web_system 版本同源，路径口径改为 Next.js App Router + features 组件。
# 被 hook-ui-prototype-gate.py 复用。失败一律 fail-open。
# ============================================================
import fnmatch
import json
import os
import re
import sys
import time

NL = chr(10)
STATE_REL = '.codebuddy/.state'
LOG_NAME = 'ui-gate.log'
MARKER_SUFFIX = '-ui.json'
TTL_HOURS = 4

# —— AppLoom UI 触发面（Next.js）——
UI_PATH_GLOBS = [
    'apps/web/src/app/**/page.tsx',
    'apps/web/src/app/**/*.tsx',
    'apps/web/src/features/**/*.tsx',
    'apps/web/src/features/**/*.ts',
    'apps/web/src/components/**/*',
]
UI_EXTS = ('.tsx', '.css')

# —— UI 凭证（原型 / 页面规格）——
PASSPORT_GLOBS = [
    'docs/prototype/*',
    'docs/prototype/**/*',
    'docs/plans/*',
    'specs/*/page-spec*.md',
    'specs/page-spec*.md',
    'page-spec*.md',
]

WRITE_TOOLS = {'write_to_file', 'replace_in_file', 'Write', 'Edit', 'MultiEdit', 'apply_patch'}
EXEMPT_RE = re.compile(r'微调豁免|Micro-exempt|机械重构|零视觉变化')
EXEMPT_ENV = 'UI_GATE'


def read_payload():
    raw = sys.stdin.read()
    try:
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def project_root(payload=None):
    # 优先 payload.cwd（真实项目根）；env 可能指向工作区而非项目
    cwd = (payload or {}).get('cwd')
    if cwd and os.path.isdir(cwd):
        return os.path.realpath(cwd)
    v = os.environ.get('CODEBUDDY_PROJECT_DIR') or os.environ.get('CLAUDE_PROJECT_DIR')
    if v and os.path.isdir(v):
        return os.path.realpath(v)
    return os.path.realpath(os.getcwd())


def to_rel(path, root):
    # 相对路径要按项目根解析，不能按 cwd（cwd 可能是任意工作区）
    if not os.path.isabs(path):
        path = os.path.join(root, path)
    try:
        path = os.path.realpath(path)
    except Exception:
        pass
    if path.startswith(root + os.sep):
        return path[len(root) + 1:]
    return path


def matches_any(rel, globs, exts=()):
    rel = rel.replace(os.sep, '/')
    if exts and any(rel.endswith(e) for e in exts):
        return True
    for pat in globs:
        if fnmatch.fnmatch(rel, pat):
            return True
    return False


def is_ui_source(rel):
    return matches_any(rel, UI_PATH_GLOBS, UI_EXTS)


def is_passport(rel):
    return matches_any(rel, PASSPORT_GLOBS)


def state_dir(root):
    return os.path.join(root, STATE_REL)


def marker_path(root, session_id):
    safe = ''.join(ch for ch in (session_id or '') if ch.isalnum() or ch in '-_')
    suffix = safe + MARKER_SUFFIX if safe else 'ui-touched'
    return os.path.join(state_dir(root), suffix)


def load_marker(root, session_id):
    for p in (marker_path(root, session_id), os.path.join(state_dir(root), 'ui-touched')):
        if os.path.isfile(p):
            try:
                with open(p, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                continue
    return None


def save_marker(root, session_id, info):
    d = state_dir(root)
    try:
        os.makedirs(d, exist_ok=True)
        with open(marker_path(root, session_id), 'w', encoding='utf-8') as f:
            json.dump(info, f, ensure_ascii=False)
        with open(os.path.join(d, 'ui-touched'), 'w', encoding='utf-8') as f:
            json.dump(info, f, ensure_ascii=False)
    except Exception:
        pass


def marker_fresh(data):
    if not data:
        return False
    try:
        ts = float(data.get('ts', 0))
    except Exception:
        return False
    return ts > 0 and (time.time() - ts) <= TTL_HOURS * 3600


def deny(reason, stop_reason='UI 改动须先过原型'):
    out = {
        'continue': False,
        'stopReason': stop_reason,
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': reason,
        },
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


def allow_with_context(text):
    out = {
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'additionalContext': text,
        }
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


def audit(root, decision, tool_name, path, session_id='', extra=None):
    try:
        d = state_dir(root)
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, LOG_NAME)
        rec = {'ts': int(time.time()), 'session_id': session_id,
               'tool_name': tool_name, 'path': path, 'decision': decision}
        if extra:
            rec.update(extra)
        with open(p, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + NL)
    except Exception:
        pass


def extract_path(ti):
    if not isinstance(ti, dict):
        return ''
    path = (ti.get('filePath') or ti.get('file_path') or ti.get('path') or '').strip()
    if path:
        return path
    for e in (ti.get('edits') or []):
        if isinstance(e, dict) and e.get('file_path'):
            return e['file_path']
    return ''


def extract_text(ti):
    if not isinstance(ti, dict):
        return ''
    parts = []
    for k in ('content', 'new_string', 'patch'):
        if isinstance(ti.get(k), str):
            parts.append(ti[k])
    for e in (ti.get('edits') or []):
        if isinstance(e, dict) and isinstance(e.get('new_string'), str):
            parts.append(e['new_string'])
    return ''.join(parts)


def exempt_by_env():
    return (os.environ.get(EXEMPT_ENV, '') or '').lower() in ('off', '0', 'false')
