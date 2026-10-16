/**
 * CodegenGate —— 代码生成产物的确定性验证门禁（Harness 层，不依赖 prompt 约束）
 *
 *  L1 结构：路径安全 / 重复 / 空内容 / package.json 可解析 / 依赖与启动脚本一致（纯函数，零 IO）
 *  L2 静态：node_modules/.bin/tsc --noEmit（仅当有 tsconfig.json 且已安装 typescript）
 *  L3 动态：install + `<pm> run build`（仅当有 package.json 且声明了 build 脚本）
 *
 * 原则：成功静默（只返回 passed），失败大声（结构化 failures，可原样回喂模型修复）。
 * 校验在独立目录 /tmp/apploom-gate/{docId} 中进行，与部署目录隔离；node_modules 在多轮间复用。
 *
 * 环境变量：
 *   CODEGEN_GATE              enforce（默认，未通过则阶段失败）| warn（只记录告警）| off
 *   CODEGEN_GATE_MAX_REPAIRS  未通过时自动回喂修复的最大轮数，默认 2
 */
import { Injectable } from '@nestjs/common';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { createDefaultRegistry, type Approver } from '@apploom/tools';
import { ApprovalService } from '../approval/approval.service';
import { detectPackageManager } from '../deploy/local-deploy.service';

export type GateMode = 'enforce' | 'warn' | 'off';
export type GateCheck = 'structure' | 'install' | 'typecheck' | 'build';

export interface GateFailure {
  check: GateCheck;
  message: string;
  /** 命令输出（已裁剪），供模型定位问题 */
  detail?: string;
}

export interface GateReport {
  passed: boolean;
  failures: GateFailure[];
  /** 实际执行过的检查及耗时 */
  checks: Array<{ name: GateCheck; ok: boolean; ms: number }>;
}

export interface CodegenInput {
  files: { path: string; content: string }[];
  dependencies: string[];
  runCommand: string;
}

const GATE_ROOT = '/tmp/apploom-gate';
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const TSC_TIMEOUT_MS = 3 * 60 * 1000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const DETAIL_LIMIT = 4000;

export function gateMode(): GateMode {
  const v = (process.env.CODEGEN_GATE ?? 'enforce').toLowerCase();
  return v === 'off' || v === 'warn' ? v : 'enforce';
}

export function gateMaxRepairs(): number {
  const n = Number(process.env.CODEGEN_GATE_MAX_REPAIRS ?? 2);
  return Number.isInteger(n) && n >= 0 ? n : 2;
}

/** "react@^18" → "react"；"@prisma/client@5" → "@prisma/client" */
function packageName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/** L1：纯函数结构校验 */
export function checkStructure(codegen: CodegenInput): GateFailure[] {
  const failures: GateFailure[] = [];
  const fail = (message: string) => failures.push({ check: 'structure', message });

  if (codegen.files.length === 0) {
    fail('files 为空，没有任何可运行的文件');
    return failures;
  }

  const seen = new Set<string>();
  for (const f of codegen.files) {
    const p = f.path.trim();
    const segments = p.split(/[\\/]/);
    if (!p) fail('存在空路径的文件');
    else if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) fail(`路径必须是相对路径: ${f.path}`);
    else if (segments.includes('..')) fail(`路径不允许包含 "..": ${f.path}`);
    else if (seen.has(p)) fail(`文件路径重复: ${f.path}`);
    seen.add(p);
    if (!f.content.trim()) fail(`文件内容为空: ${f.path}`);
  }

  const pkgFile = codegen.files.find((f) => f.path.trim() === 'package.json');
  if (pkgFile) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(pkgFile.content);
    } catch (e) {
      fail(`package.json 不是合法 JSON: ${(e as Error).message}`);
      return failures;
    }

    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    const missing = codegen.dependencies.map(packageName).filter((n) => !(n in declared));
    if (missing.length > 0) fail(`dependencies 声明了但 package.json 中不存在: ${missing.join(', ')}`);

    const m = codegen.runCommand.trim().match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)$/);
    if (m && m[1] !== 'start' && !pkg.scripts?.[m[1]]) {
      fail(`runCommand 为 "${codegen.runCommand}"，但 package.json 的 scripts 中没有 "${m[1]}"`);
    }
  }
  return failures;
}

/** 把失败列表格式化为可回喂模型的修复反馈 */
export function formatFailures(failures: GateFailure[]): string {
  const body = failures
    .map((f, i) => `${i + 1}. [${f.check}] ${f.message}${f.detail ? `\n${f.detail}` : ''}`)
    .join('\n\n');
  return `你上一次生成的代码未通过自动校验，请逐条修复后重新输出完整的 CodegenDocument（保持其它部分不变）：\n\n${body}`;
}

function clip(text: string, mode: 'head' | 'tail'): string {
  const t = text.trim();
  if (t.length <= DETAIL_LIMIT) return t;
  return mode === 'head' ? `${t.slice(0, DETAIL_LIMIT)}\n…（已截断）` : `…（已截断）\n${t.slice(-DETAIL_LIMIT)}`;
}

@Injectable()
export class CodegenGateService {
  private readonly tools = createDefaultRegistry();

  constructor(private readonly approvals: ApprovalService) {}

  async verify(docId: string, codegen: CodegenInput, onLog: (line: string) => void): Promise<GateReport> {
    const report: GateReport = { passed: false, failures: [], checks: [] };
    const approver = this.approvals.approverFor(docId, 'codegen');
    const record = async (name: GateCheck, run: () => Promise<GateFailure | null>) => {
      const start = Date.now();
      const failure = await run();
      report.checks.push({ name, ok: !failure, ms: Date.now() - start });
      if (failure) report.failures.push(failure);
      onLog(`[gate] ${name} ${failure ? '✕' : '✓'}`);
      return !failure;
    };

    const structureFailures = checkStructure(codegen);
    report.checks.push({ name: 'structure', ok: structureFailures.length === 0, ms: 0 });
    if (structureFailures.length > 0) {
      report.failures.push(...structureFailures);
      onLog(`[gate] structure ✕ ${structureFailures.length} 项`);
      return report;
    }
    onLog('[gate] structure ✓');

    const root = path.join(GATE_ROOT, docId);
    await this.resetWorkspace(root);
    for (const f of codegen.files) {
      const r = await this.tools.execute('write_file', { path: f.path, content: f.content }, { workspace: root });
      if (!r.ok) {
        report.failures.push({ check: 'structure', message: `写入失败: ${f.path}: ${r.error}` });
        return report;
      }
    }

    if (!existsSync(path.join(root, 'package.json'))) {
      onLog('[gate] 无 package.json（静态产物），跳过 install / typecheck / build');
      report.passed = true;
      return report;
    }

    const pm = detectPackageManager(root, codegen.runCommand);
    const installed = await record('install', async () => {
      const r = await this.exec(pm.installCmd[0], pm.installCmd.slice(1), root, INSTALL_TIMEOUT_MS, approver);
      return r.ok ? null : { check: 'install', message: `${pm.name} install 失败（${r.reason}）`, detail: clip(r.output, 'tail') };
    });
    if (!installed) return report;

    if (existsSync(path.join(root, 'tsconfig.json')) && existsSync(path.join(root, 'node_modules/.bin/tsc'))) {
      const typecheckOk = await record('typecheck', async () => {
        const r = await this.exec('node_modules/.bin/tsc', ['--noEmit'], root, TSC_TIMEOUT_MS, approver);
        return r.ok ? null : { check: 'typecheck', message: `tsc --noEmit 未通过（${r.reason}）`, detail: clip(r.output, 'head') };
      });
      if (!typecheckOk) return report;
    }

    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.build) {
      await record('build', async () => {
        const r = await this.exec(pm.name, ['run', 'build'], root, BUILD_TIMEOUT_MS, approver);
        return r.ok ? null : { check: 'build', message: `${pm.name} run build 未通过（${r.reason}）`, detail: clip(r.output, 'tail') };
      });
    }

    report.passed = report.failures.length === 0;
    return report;
  }

  /** 清空校验目录但保留 node_modules，避免多轮重复安装 */
  private async resetWorkspace(root: string): Promise<void> {
    await fs.mkdir(root, { recursive: true });
    for (const entry of await fs.readdir(root)) {
      if (entry === 'node_modules') continue;
      await fs.rm(path.join(root, entry), { recursive: true, force: true });
    }
  }

  private async exec(command: string, args: string[], cwd: string, timeoutMs: number, approver: Approver) {
    const r = await this.tools.execute('shell', { command, args, cwd, timeoutMs, maxOutputBytes: 256 * 1024 }, { workspace: cwd, approver });
    const reason = r.error ?? `退出码 ${r.exitCode ?? '未知'}`;
    return { ok: r.ok, output: r.output || r.error || '', reason };
  }
}
