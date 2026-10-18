/**
 * 沙箱入口：为一次「运行不可信命令」的场景准备最小环境变量 + OS 级命令包装。
 *
 * SANDBOX_MODE：
 *   auto（默认）  平台支持就启用（macOS: sandbox-exec），不支持则告警一次并退化为只做环境变量白名单
 *   seatbelt     必须启用，不可用时直接抛错（多用户 / 生产环境应使用强制模式，宁可不跑也不裸跑）
 *   container    必须用容器（docker / podman，可配 gVisor）执行，引擎不可用时直接抛错；见 container.ts
 *   off          不做 OS 级隔离（仅环境变量白名单）
 */
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { sandboxEnv, sandboxHome, sandboxHomeBase } from './sandbox-env';
import { ContainerExecutor, containerOptions, isContainerAvailable } from './container';
import { SeatbeltExecutor, type SandboxExecutor, type SandboxPolicy, type WrappedCommand } from './seatbelt';

export type SandboxMode = 'auto' | 'seatbelt' | 'container' | 'off';

export interface SandboxContext {
  /** 子进程环境变量（白名单） */
  env: Record<string, string>;
  /** OS 级沙箱的命令包装；缺省 = 未启用 OS 级隔离 */
  wrap?: (cmd: WrappedCommand) => WrappedCommand;
  /** 实际生效的隔离实现，便于日志与测试 */
  executor: string;
}

/** 各租户 / 各 doc 工作区所在的根目录：沙箱内默认不可读，只放行自己那一份 */
export const ISOLATED_ROOTS = ['/tmp/apploom-deploy', '/tmp/apploom-gate', '/tmp/apploom-artifacts'];

export function sandboxMode(env: NodeJS.ProcessEnv = process.env): SandboxMode {
  const v = (env.SANDBOX_MODE ?? 'auto').toLowerCase();
  return v === 'seatbelt' || v === 'container' || v === 'off' ? v : 'auto';
}

let warnedUnavailable = false;

/** 按模式与平台选执行器；返回 null = 不做 OS 级隔离 */
export function resolveExecutor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SandboxExecutor | null {
  const mode = sandboxMode(env);
  if (mode === 'off') return null;
  if (mode === 'container') {
    const opts = containerOptions(env);
    if (!isContainerAvailable(opts.cli)) throw new Error(`SANDBOX_MODE=container 但 ${opts.cli} 引擎不可用。拒绝在没有隔离的情况下执行不可信代码`);
    return new ContainerExecutor(opts);
  }
  if (SeatbeltExecutor.isAvailable(platform)) return new SeatbeltExecutor();
  if (mode === 'seatbelt') throw new Error(`SANDBOX_MODE=seatbelt 但当前平台不支持（${platform}）。拒绝在没有隔离的情况下执行不可信代码`);
  if (!warnedUnavailable) {
    warnedUnavailable = true;
    console.warn(`[sandbox] 当前平台（${platform}）没有可用的 OS 级沙箱，仅启用环境变量白名单。多用户 / 生产环境请使用容器等隔离并设置 SANDBOX_MODE=seatbelt 等强制模式`);
  }
  return null;
}

/** node 安装目录：沙箱要放行读取（常见于家目录下的 fnm / nvm / 用户级 homebrew，而家目录整体不可读） */
function toolchainDirs(pathEnv: string | undefined): string[] {
  const dirs: string[] = [];
  for (const dir of (pathEnv ?? '').split(path.delimiter).filter(Boolean)) {
    const bin = path.join(dir, 'node');
    if (!existsSync(bin)) continue;
    try {
      const realBin = realpathSync(bin);
      dirs.push(path.dirname(path.dirname(realBin))); // …/installation/bin/node → …/installation
      break;
    } catch {
      /* 断链：换下一个 */
    }
  }
  return dirs;
}

function dbPortFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const p = Number(new URL(url).port);
    return p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** 沙箱内禁止连接的基础设施端口：Redis / 数据库 / API 自身，及 SANDBOX_DENY_PORTS 追加 */
export function infraPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const extra = (env.SANDBOX_DENY_PORTS ?? '').split(',').map((s) => Number(s.trim()));
  const ports = [Number(env.REDIS_PORT ?? 6379), Number(env.PORT ?? 3001), 3306, 5432, dbPortFromUrl(env.DATABASE_URL), ...extra];
  return [...new Set(ports.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536))];
}

function extraReadDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.SANDBOX_READ_ALLOW ?? '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

export function buildPolicy(workspace: string, env: NodeJS.ProcessEnv = process.env, tenant?: string): SandboxPolicy {
  return {
    workspace,
    writableDirs: [sandboxHome(env, tenant)],
    readableDirs: [...toolchainDirs(env.PATH), ...extraReadDirs(env)],
    // 多租户时公共 HOME 根目录整体不可读（只放行自己租户那一份），其它租户的缓存与临时文件看不到
    isolatedRoots: tenant ? [...ISOLATED_ROOTS, sandboxHomeBase(env)] : ISOLATED_ROOTS,
    denyPorts: infraPorts(env),
  };
}

/**
 * 为 workspace 里的一次执行准备沙箱上下文。
 * extraEnv：调用方的固定环境变量（如 BROWSER=none）。tenant：多用户时的租户（流水线 ownerId），决定独立的 HOME / 包管理器缓存。
 */
export function sandboxContext(workspace: string, extraEnv: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env, tenant?: string): SandboxContext {
  const childEnv = sandboxEnv(extraEnv, env, tenant);
  const executor = resolveExecutor(env);
  if (!executor) return { env: childEnv, executor: 'none' };
  const policy = { ...buildPolicy(workspace, env, tenant), env: childEnv };
  return { env: childEnv, wrap: (cmd) => executor.wrap(policy, cmd), executor: executor.name };
}

const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_|$)/i;

/** 启动环境里疑似密钥的变量名（只返回名字，不接触值） */
export function findSecretEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((k) => env[k] && (SECRET_NAME.test(k) || k === 'DATABASE_URL'))
    .sort();
}
