/**
 * macOS Seatbelt（sandbox-exec）执行器：给不可信命令（LLM 生成项目的 install / build / dev server）套 OS 级限制。
 *
 * 这是「可替换沙箱」的第一个实现；容器 / 微虚机 / 托管沙箱实现同一个 SandboxExecutor 接口即可替换。
 *
 * 能限制（均已用真实进程实测）：
 *   - 写：只能写工作区与沙箱 HOME
 *   - 读：看不到 /Users（家目录：~/.ssh、仓库 .env 等）与其它 doc 的工作区；工具链（node 安装目录）单独放行
 *   - 信号：不能给沙箱外的进程发信号
 *   - 网络：不能连基础设施端口（Redis / 数据库 / API 自身），其余放行（install 需要访问 registry）
 * 限制不了：同用户进程读取其它进程「启动时的环境变量快照」（sysctl KERN_PROCARGS2）——Seatbelt 管不到这条
 *   通道（实测连 deny default 也拦不住）。所以 API 必须用干净环境启动，见 sandbox.ts 的启动自检。
 */
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

export interface SandboxPolicy {
  /** 唯一可读写的工作区 */
  workspace: string;
  /** 额外可读写目录（沙箱 HOME 等） */
  writableDirs?: string[];
  /** 额外只读目录（工具链安装目录等） */
  readableDirs?: string[];
  /** 其它租户 / 其它 doc 所在的根目录：默认不可读，仅放行 workspace 自己 */
  isolatedRoots?: string[];
  /** 禁止连接的端口（任意主机），用于基础设施：Redis / 数据库 / API */
  denyPorts?: number[];
}

export interface WrappedCommand {
  command: string;
  args: string[];
}

export interface SandboxExecutor {
  readonly name: string;
  wrap(policy: SandboxPolicy, cmd: WrappedCommand): WrappedCommand;
}

/** SBPL 字符串字面量：拒绝会破坏语法 / 注入规则的字符，而不是尝试转义 */
function lit(p: string): string {
  if (/["\\\u0000-\u001f]/.test(p)) throw new Error(`沙箱路径含非法字符: ${JSON.stringify(p)}`);
  return `"${p}"`;
}

/** Seatbelt 按真实路径匹配（/tmp 实为 /private/tmp），必须先 realpath；不存在则退回绝对路径 */
function real(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

const unique = (xs: string[]) => [...new Set(xs)];

/** 生成 profile 文本。规则「后者优先」：先整体拒绝，再逐项放行。 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const writable = unique([policy.workspace, ...(policy.writableDirs ?? [])].map(real));
  const readable = unique([...writable, ...(policy.readableDirs ?? []).map(real)]);
  const isolated = unique((policy.isolatedRoots ?? []).map(real));
  const ports = unique((policy.denyPorts ?? []).filter((n) => Number.isInteger(n) && n > 0 && n < 65536).map(String));

  const lines = [
    '(version 1)',
    '(allow default)',
    // 写：默认全拒，只放行工作区 / 沙箱 HOME 与几个必须的设备文件
    '(deny file-write*)',
    `(allow file-write* ${writable.map((d) => `(subpath ${lit(d)})`).join(' ')} (literal "/dev/null") (literal "/dev/dtracehelper"))`,
    // 读：家目录与其它租户的目录整体拒绝（只拒读数据，stat 仍可用，保证路径解析不出错），再放行自己的
    `(deny file-read-data (subpath "/Users")${isolated.map((d) => ` (subpath ${lit(d)})`).join('')})`,
    `(allow file-read-data ${readable.map((d) => `(subpath ${lit(d)})`).join(' ')})`,
    // 信号：只能给自己和同沙箱的进程发（API 作为沙箱外的父进程仍可杀它们）
    '(deny signal)',
    '(allow signal (target self))',
    '(allow signal (target same-sandbox))',
    // 剪贴板 / 钥匙串
    '(deny mach-lookup (global-name "com.apple.pasteboard.1") (global-name "com.apple.SecurityServer"))',
  ];
  if (ports.length > 0) {
    lines.push(`(deny network-outbound ${ports.map((n) => `(remote ip "*:${n}")`).join(' ')})`);
  }
  return lines.join('\n');
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export class SeatbeltExecutor implements SandboxExecutor {
  readonly name = 'seatbelt';

  static isAvailable(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): boolean {
    return platform === 'darwin' && exists(SANDBOX_EXEC);
  }

  wrap(policy: SandboxPolicy, cmd: WrappedCommand): WrappedCommand {
    return { command: SANDBOX_EXEC, args: ['-p', buildSeatbeltProfile(policy), cmd.command, ...cmd.args] };
  }
}
