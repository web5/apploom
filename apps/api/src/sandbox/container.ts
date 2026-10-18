/**
 * 容器沙箱执行器（SANDBOX_MODE=container）：把不可信命令放进一次性容器里跑，实现与 Seatbelt 同一个 SandboxExecutor 接口。
 * 面向 Linux 生产主机；配 gVisor（SANDBOX_CONTAINER_RUNTIME=runsc）可得到用户态内核级隔离（容器逃逸面更小）。
 *
 * 隔离点：
 *   - 文件系统：根文件系统只读，仅挂载工作区与租户 HOME（宿主路径与容器内路径相同，cwd / HOME 无需改写），其它租户的目录根本不存在
 *   - 权限：以调用者 uid/gid 运行、丢弃全部 capability、no-new-privileges；限制内存 / CPU / 进程数（防 fork 炸弹与挖矿）
 *   - 网络：默认 bridge。容器无法访问宿主回环上的 Redis / 数据库 / API；install 需要的外网照常可用。
 *     SANDBOX_CONTAINER_NETWORK=none 可完全断网（只适合不需要 install 的场景）
 *   - 环境变量：只带 sandbox-env 白名单后的变量，宿主进程环境不会泄漏进去
 *
 * 暂未覆盖：dev server 预览。容器内的端口默认不对宿主开放，预览需要「端口发布 + 反向代理」这一步（见 preview/）；
 * 目前 install / build / 代码门禁这类「跑完即退」的命令可以放心使用容器。本文件的参数构造有单测，但尚未在真实 Docker 守护进程上验证过。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { SandboxExecutor, SandboxPolicy, WrappedCommand } from './seatbelt';

export interface ContainerOptions {
  /** docker 或 podman */
  cli: string;
  image: string;
  /** OCI 运行时，如 runsc（gVisor）；缺省用引擎默认 */
  runtime?: string;
  memory: string;
  cpus: string;
  pids: number;
  network: string;
  uid?: number;
  gid?: number;
}

export function containerOptions(env: NodeJS.ProcessEnv = process.env): ContainerOptions {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    cli: env.SANDBOX_CONTAINER_CLI || 'docker',
    image: env.SANDBOX_IMAGE || 'node:20-bookworm-slim',
    runtime: env.SANDBOX_CONTAINER_RUNTIME || undefined,
    memory: env.SANDBOX_CONTAINER_MEMORY || '2g',
    cpus: env.SANDBOX_CONTAINER_CPUS || '2',
    pids: num(env.SANDBOX_CONTAINER_PIDS, 512),
    network: env.SANDBOX_CONTAINER_NETWORK || 'bridge',
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    gid: typeof process.getgid === 'function' ? process.getgid() : undefined,
  };
}

/** docker 引擎是否可用（结果缓存：每次执行命令都会问一遍） */
let availability: boolean | undefined;
export function isContainerAvailable(cli = 'docker', probe: (cli: string) => boolean = (c) => spawnSync(c, ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', timeout: 5000 }).status === 0): boolean {
  availability ??= probe(cli);
  return availability;
}

/** 路径直接作为 -v 的一段：冒号 / 换行 / 逗号会改变挂载语义，拒绝而不是转义 */
function mountable(p: string): string {
  const abs = path.resolve(p);
  if (/[:,\n\r\u0000]/.test(abs)) throw new Error(`容器挂载路径含非法字符: ${JSON.stringify(abs)}`);
  return abs;
}

export class ContainerExecutor implements SandboxExecutor {
  readonly name: string;

  constructor(private readonly opts: ContainerOptions = containerOptions()) {
    this.name = opts.runtime ? `container(${opts.runtime})` : 'container';
  }

  wrap(policy: SandboxPolicy, cmd: WrappedCommand): WrappedCommand {
    const o = this.opts;
    const workspace = mountable(policy.workspace);
    const rw = [...new Set([workspace, ...(policy.writableDirs ?? []).map(mountable)])];
    const ro = [...new Set((policy.readableDirs ?? []).map(mountable))].filter((d) => !rw.includes(d));

    const args = ['run', '--rm', '-i', '--init', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
    if (o.runtime) args.push('--runtime', o.runtime);
    args.push('--memory', o.memory, '--cpus', o.cpus, '--pids-limit', String(o.pids), '--network', o.network);
    if (o.uid !== undefined && o.gid !== undefined) args.push('--user', `${o.uid}:${o.gid}`);
    for (const d of rw) args.push('-v', `${d}:${d}:rw`);
    for (const d of ro) args.push('-v', `${d}:${d}:ro`);
    args.push('-w', workspace);
    for (const [k, v] of Object.entries(policy.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\n\r\u0000]/.test(v)) throw new Error(`容器环境变量非法: ${k}`);
      args.push('-e', `${k}=${v}`);
    }
    args.push(o.image, cmd.command, ...cmd.args);
    return { command: o.cli, args };
  }
}
