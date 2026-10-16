/**
 * LocalDeployService —— W7+1 本地真部署 MVP
 *
 * 不再让 LLM 描述部署，而是真实执行 codegen 产物：
 *   1) 写代码到 /tmp/apploom-deploy/{docId}/（走 @apploom/tools 的 write_file）
 *   2) 跑 install（npm / pnpm / yarn 自适应，走 shell 工具）
 *   3) 后台启动 dev server（detached child process）
 *   4) 解析 stdout 抓本地 URL（vite / next / webpack-dev-server 等）
 *
 * 安全边界：
 *   - 文件写入/命令执行全部委托 @apploom/tools 沙箱层（workspace-write 档位），
 *     路径越界（../../etc/passwd）由 sandbox.ts 拒绝，不再在本文件手写校验
 *   - install timeout 5 分钟
 *   - dev server 启动后 30 秒内未解析到 URL 则标 failed
 *
 * 设计取舍：
 *   - 不做 sandbox（chroot / docker / seccomp）：MVP 范围，依赖 tools 沙箱（路径白名单）
 *   - 不做 stop API / 退出清理：dev server 以 detached + unref 启动，API 重启后仍存活并继续占端口；
 *     同端口再次部署时由 freePort 终止（自己的旧进程免审批）。不同端口的旧进程会一直留着，需手动清理
 *   - 不并发限制（先跑通，跑挂再调）
 *   - 端口检查（lsof/kill）是系统级运维细节，不属于 Agent 基础能力，保留本地实现
 */
import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { createDefaultRegistry, type ApprovalDecision, type Approver } from '@apploom/tools';
import { ApprovalService } from '../approval/approval.service';
import { assessRunCommand, isOwnDeployProcess } from '../approval/policy';
import { sandboxContext } from '../sandbox/sandbox';

export type DeployStatus = 'success' | 'failed';

export interface DeployOutput {
  target: 'local';
  url: string;
  repoUrl: '';
  buildLog: string;
  status: DeployStatus;
}

/** 工具注册表（模块级单例：4 个基础工具 + 追加式调用日志） */
const tools = createDefaultRegistry();

/** 识别 package manager（看 lockfile 与 runCommand） */
export function detectPackageManager(
  cwd: string,
  runCommand: string,
): { name: 'pnpm' | 'npm' | 'yarn'; installCmd: string[] } {
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return { name: 'pnpm', installCmd: ['pnpm', 'install', '--prefer-offline'] };
  if (existsSync(path.join(cwd, 'yarn.lock'))) return { name: 'yarn', installCmd: ['yarn', 'install'] };
  if (existsSync(path.join(cwd, 'package-lock.json'))) return { name: 'npm', installCmd: ['npm', 'install', '--no-audit', '--no-fund'] };
  // 兜底：看 runCommand 关键词
  if (/pnpm/.test(runCommand)) return { name: 'pnpm', installCmd: ['pnpm', 'install', '--prefer-offline'] };
  if (/yarn/.test(runCommand)) return { name: 'yarn', installCmd: ['yarn', 'install'] };
  return { name: 'npm', installCmd: ['npm', 'install', '--no-audit', '--no-fund'] };
}

/**
 * 跑命令（走 shell 工具，沙箱档位 workspace-write）。
 * install 日志可能很长，放开输出上限到 1MB，保证 buildLog 完整。
 */
async function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  onLog: (line: string) => void,
  timeoutMs: number,
  approver: Approver,
): Promise<number> {
  onLog(`$ ${cmd} ${args.join(' ')}`);
  const sbx = sandboxContext(cwd);
  const r = await tools.execute(
    'shell',
    { command: cmd, args, cwd, timeoutMs, maxOutputBytes: 1024 * 1024 },
    { workspace: cwd, onLog, approver, env: sbx.env, wrap: sbx.wrap },
  );
  return r.exitCode ?? 1;
}

/** 从 dev server stdout 中解析本地 URL（vite / next / webpack-dev-server 等通用正则） */
function parseLocalUrl(text: string): string | null {
  // 先去 ANSI 转义码（vite 会用 \u001b[36m...\u001b[1m5178\u001b[22m 把 URL 切开）
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
  const m = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/);
  return m ? m[0].replace('0.0.0.0', 'localhost') : null;
}

/** 写盘（走 write_file 工具）：所有文件必须在 ROOT/{docId} 下（sandbox.ts 强制） */
const ROOT = '/tmp/apploom-deploy';

/** 执行只读系统命令并收集 stdout（失败返回空串） */
function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: false });
    let out = '';
    p.stdout?.on('data', (b) => (out += b.toString()));
    p.stderr?.on('data', () => {});
    p.on('error', () => resolve(''));
    p.on('exit', () => resolve(out));
  });
}

async function inspectProcess(pid: string): Promise<{ name: string; cwd: string }> {
  const name = (await capture('ps', ['-p', pid, '-o', 'comm='])).trim() || '未知';
  const cwdLine = (await capture('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])).split('\n').find((l) => l.startsWith('n'));
  return { name, cwd: cwdLine?.slice(1) ?? '' };
}

/**
 * 释放端口。占用者若是 AppLoom 之前部署的 dev server（cwd 在部署目录下）直接终止；
 * 其它进程属于「杀别人的进程」，必须经人工审批（HITL）。返回 null = 端口可用，否则为失败原因。
 */
async function freePort(
  port: number,
  onLog: (line: string) => void,
  askApproval: (summary: string) => Promise<ApprovalDecision>,
): Promise<string | null> {
  const pids = (await capture('lsof', ['-ti', `:${port}`])).trim().split('\n').filter(Boolean);
  if (pids.length === 0) {
    onLog(`[port] ${port} 空闲`);
    return null;
  }

  // macOS 的 /tmp 是 /private/tmp 的软链，lsof 报告真实路径，两种前缀都要认
  const roots = [ROOT, await fs.realpath(ROOT).catch(() => ROOT)];
  for (const pid of pids) {
    const info = await inspectProcess(pid);
    if (!isOwnDeployProcess(info.cwd, roots)) {
      const summary = `终止占用端口 ${port} 的进程 PID ${pid}（${info.name}，cwd: ${info.cwd || '未知'}）——该进程不是 AppLoom 部署的 dev server`;
      onLog(`[port] ${summary}，等待人工审批`);
      const decision = await askApproval(summary);
      if (decision !== 'allowed-once') {
        const reason = decision === 'rejected' ? '已被拒绝' : '审批超时/不可用';
        return `端口 ${port} 被非 AppLoom 进程 ${pid}（${info.name}）占用，终止操作${reason}，未部署`;
      }
    }
    try {
      process.kill(Number(pid), 'SIGKILL');
      onLog(`[port] ✓ 已 kill ${pid}（${info.name}）`);
    } catch (e) {
      onLog(`[port] ✕ kill ${pid} 失败: ${(e as Error).message}`);
    }
  }
  // 等一小会让内核释放端口
  await new Promise((r) => setTimeout(r, 500));
  return null;
}

async function writeFiles(
  docId: string,
  files: { path: string; content: string }[],
  onLog: (line: string) => void,
): Promise<string> {
  const workspace = path.join(ROOT, docId);
  await fs.mkdir(workspace, { recursive: true });
  for (const f of files) {
    const r = await tools.execute('write_file', { path: f.path, content: f.content }, { workspace, onLog });
    if (!r.ok) throw new Error(r.error);
  }
  onLog(`[write] ${files.length} 个文件 → ${workspace}`);
  return workspace;
}

@Injectable()
export class LocalDeployService {
  private readonly logger = new Logger(LocalDeployService.name);

  constructor(private readonly approvals: ApprovalService) {}

  async deploy(
    docId: string,
    codegen: {
      files: { path: string; content: string }[];
      dependencies: string[];
      runCommand: string;
    },
    onProgress: (chunk: string) => void,
    port?: number,
  ): Promise<DeployOutput> {
    const log: string[] = [];
    const writeLog = (line: string) => {
      log.push(line);
    };
    /** 只推「关键节点」给 SSE，避免高频输出撑爆流（install/dev 的细节都进 buildLog） */
    const step = (line: string) => onProgress(line);

    step('═══ 本地真部署开始 ═══');

    // 1) 写盘
    const root = await writeFiles(docId, codegen.files, writeLog);
    step(`[write] ✓ ${codegen.files.length} 个文件已写入 ${root}`);

    // 2) 跑 install（如果 codegen 生成了 package.json 才 install；纯静态站跳过）
    if (existsSync(path.join(root, 'package.json'))) {
      const pm = detectPackageManager(root, codegen.runCommand);
      step(`[install] ${pm.installCmd[0]} · ${codegen.dependencies.length} 个依赖（最多 5 分钟）`);
      const installCode = await runCmd(pm.installCmd[0], pm.installCmd.slice(1), root, writeLog, 5 * 60 * 1000, this.approvals.approverFor(docId, 'deploy'));
      if (installCode !== 0) {
        writeLog(`[install] ✕ 退出码 ${installCode}`);
        step(`[install] ✕ 退出码 ${installCode}`);
        return {
          target: 'local',
          url: '',
          repoUrl: '',
          buildLog: log.join('\n'),
          status: 'failed',
        };
      }
      step('[install] ✓ 依赖安装完成');
    } else {
      step('[install] - 无 package.json，跳过依赖安装（纯静态产物）');
    }

    // 3) 启动 dev server（detached，后台跑）
    const abort = (reason: string): DeployOutput => {
      writeLog(`[deploy] ✕ ${reason}`);
      step(`[deploy] ✕ ${reason}`);
      return { target: 'local', url: '', repoUrl: '', buildLog: log.join('\n'), status: 'failed' };
    };
    const runCommand = codegen.runCommand.trim();

    // 启动命令由 LLM 生成，先过策略：破坏性命令直接拒绝，可疑命令人工确认
    const verdict = assessRunCommand(runCommand);
    if (verdict.action === 'deny') return abort(`启动命令被策略拒绝（${verdict.reason}）: ${runCommand}`);
    if (verdict.action === 'ask') {
      step(`[approval] 启动命令需要人工确认: ${runCommand}`);
      const decision = await this.approvals.request({ docId, stage: 'deploy', tool: 'dev_server', summary: `启动 dev server: ${runCommand}（${verdict.reason}）`, risk: verdict.risk });
      if (decision !== 'allowed-once') return abort(`启动命令未获批准（${decision === 'rejected' ? '已拒绝' : '审批超时'}）: ${runCommand}`);
    }

    // 启动前：若指定了期望端口，先检查占用；自己的旧 dev server 直接终止，其它进程需人工审批
    if (port) {
      const blocked = await freePort(port, writeLog, (summary) =>
        this.approvals.request({ docId, stage: 'deploy', tool: 'kill_port', summary, risk: 'high' }),
      );
      if (blocked) return abort(blocked);
      step(`[port] 目标端口 ${port} 已就绪`);
    }
    step(`[dev] 启动 ${codegen.runCommand}（解析 URL 等待 30s）`);
    // 若 runCommand 含 shell 操作符（&& | ; 等），按空格拆会把这些字符当成参数。
    // 含元字符时改用 shell 执行（组合命令只能靠 shell 解析）；纯命令保持 shell:false 安全拆分。
    // dev server 跑的是 LLM 生成的代码：只给最小环境，并套上 OS 级沙箱（见 sandbox/）
    const sbx = sandboxContext(root, { BROWSER: 'none', CI: '0' });
    const hasShellMeta = /[&|;<>]/.test(runCommand);
    const tokens = runCommand.split(/\s+/);
    const launch = hasShellMeta ? { command: '/bin/sh', args: ['-c', runCommand] } : { command: tokens[0], args: tokens.slice(1) };
    const wrapped = sbx.wrap ? sbx.wrap(launch) : launch;
    const dev = spawn(wrapped.command, wrapped.args, { cwd: root, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: sbx.env });
    dev.unref();
    this.logger.log(`dev server pid=${dev.pid} docId=${docId}`);

    // 4) 解析 URL（30s 内未解析则判 failed）
    const url = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(''), 30 * 1000);
      let captured = '';
      const collect = (b: Buffer) => {
        const text = b.toString();
        captured += text;
        log.push(text.trimEnd());
        const u = parseLocalUrl(captured);
        if (u) {
          clearTimeout(timer);
          resolve(u);
          return;
        }
      };
      dev.stdout?.on('data', collect);
      dev.stderr?.on('data', collect);
      dev.on('exit', (code) => {
        clearTimeout(timer);
        this.logger.warn(`[dev exit] code=${code} captured[${captured.length}]`);
        resolve('');
      });
    });

    if (url) {
      step(`[dev] ✓ URL: ${url}`);
      step('═══ 部署完成 ═══');
      writeLog(`\n[dev] URL: ${url}`);
      return { target: 'local', url, repoUrl: '', buildLog: log.join('\n'), status: 'success' };
    }
    step('[dev] ✕ 30s 内未解析到本地 URL');
    writeLog('[dev] ✕ 30s 内未解析到本地 URL');
    return { target: 'local', url: '', repoUrl: '', buildLog: log.join('\n'), status: 'failed' };
  }
}
