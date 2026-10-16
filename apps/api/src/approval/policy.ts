/**
 * 审批策略 —— 由代码而非 prompt 决定哪些操作需要人工介入（默认拒绝未知命令）。
 *
 *  allow  低风险、可预期的命令（依赖安装 / 构建 / 类型检查）→ 直接放行
 *  ask    可能改变外部状态或执行任意代码 → 交给人审批
 *  deny   明显破坏性命令 → 无条件拒绝，任何模式下都不可放行
 */
import * as path from 'node:path';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface Verdict {
  action: 'allow' | 'ask' | 'deny';
  risk: RiskLevel;
  reason: string;
}

const BLOCKED_BINS = new Set(['sudo', 'su', 'doas', 'mkfs', 'dd', 'shutdown', 'reboot', 'halt', 'diskutil']);
const SHELL_BINS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
/** 只影响本地依赖与构建产物的子命令；publish / login / config 等不在其中 */
const SAFE_PM_SUBCOMMANDS = new Set(['install', 'i', 'ci', 'add', 'run', 'run-script', 'test', 't', 'build', 'start', 'rebuild', 'ls', 'list', 'audit']);
/** pnpm / yarn 允许省略 `run`（pnpm dev ≡ pnpm run dev）；npm 不支持这种简写 */
const SCRIPT_SHORTHANDS = new Set(['dev', 'serve', 'preview', 'lint', 'typecheck', 'watch']);
const DESTRUCTIVE_SCRIPT =
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|>\s*\/dev\/(sd|disk)|\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b|\bsudo\b/;

export function assessShell(input: { command: string; args?: string[] }): Verdict {
  const bin = path.basename(input.command);
  const args = input.args ?? [];

  if (BLOCKED_BINS.has(bin)) return { action: 'deny', risk: 'high', reason: `禁止执行的系统级命令: ${bin}` };

  if (SHELL_BINS.has(bin)) {
    if (DESTRUCTIVE_SCRIPT.test(args.join(' '))) return { action: 'deny', risk: 'high', reason: '脚本包含破坏性命令' };
    return { action: 'ask', risk: 'high', reason: `${bin} 可执行任意脚本` };
  }

  if (PACKAGE_MANAGERS.has(bin)) {
    const sub = args.find((a) => !a.startsWith('-'));
    if (!sub || SAFE_PM_SUBCOMMANDS.has(sub) || (bin !== 'npm' && SCRIPT_SHORTHANDS.has(sub))) {
      return { action: 'allow', risk: 'low', reason: `${bin} ${sub ?? 'install'}` };
    }
    return { action: 'ask', risk: 'high', reason: `${bin} ${sub} 可能改变外部状态（发布 / 登录 / 配置）` };
  }

  if (bin === 'tsc') return { action: 'allow', risk: 'low', reason: '类型检查' };

  if (['node', 'npx', 'pnpx', 'bunx'].includes(bin)) {
    return { action: 'ask', risk: 'medium', reason: `${bin} 会执行任意脚本或下载并运行包` };
  }

  return { action: 'ask', risk: 'medium', reason: `未在白名单内的命令: ${bin}` };
}

/** 启动 dev server 时常见、可直接放行的运行器（它们本来就是在跑生成的项目代码） */
const DEV_RUNNERS = new Set(['node', 'npx', 'pnpx', 'bunx', 'vite', 'next', 'serve', 'http-server', 'ts-node', 'tsx', 'nodemon', 'python', 'python3']);

/**
 * 评估 LLM 生成的启动命令（runCommand）。允许 `a && b` / `a; b` 组合，每一段都要过策略；
 * 含管道 / 重定向 / 命令替换的一律需要人工确认，破坏性命令直接拒绝。
 */
export function assessRunCommand(line: string): Verdict {
  const cmd = line.trim();
  if (!cmd) return { action: 'deny', risk: 'low', reason: '启动命令为空' };
  if (DESTRUCTIVE_SCRIPT.test(cmd)) return { action: 'deny', risk: 'high', reason: '启动命令包含破坏性操作' };
  if (/[|<>`]|\$\(/.test(cmd.replace(/\|\|/g, ''))) {
    return { action: 'ask', risk: 'high', reason: '启动命令含管道 / 重定向 / 命令替换' };
  }

  let result: Verdict = { action: 'allow', risk: 'low', reason: '启动命令' };
  for (const seg of cmd.split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean)) {
    // 忽略前置环境变量赋值（PORT=3000 npm run dev）
    const tokens = seg.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (tokens.length === 0) continue;
    const verdict = DEV_RUNNERS.has(path.basename(tokens[0])) ? ({ action: 'allow', risk: 'low', reason: '' } as Verdict) : assessShell({ command: tokens[0], args: tokens.slice(1) });
    if (verdict.action === 'deny') return verdict;
    if (verdict.action === 'ask' && result.action === 'allow') result = verdict;
  }
  return result;
}

/** 进程 cwd 是否位于 AppLoom 自己的部署目录下（= 之前由 deploy 阶段启动的 dev server） */
export function isOwnDeployProcess(cwd: string, deployRoots: string[]): boolean {
  return deployRoots.some((root) => cwd === root || cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}
