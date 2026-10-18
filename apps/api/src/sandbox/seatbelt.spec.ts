import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createDefaultRegistry } from '@apploom/tools';
import { sandboxHome, tenantDirName } from './sandbox-env';
import { buildPolicy, findSecretEnvNames, infraPorts, resolveExecutor, sandboxContext, sandboxMode } from './sandbox';
import { buildSeatbeltProfile, SeatbeltExecutor, type SandboxPolicy } from './seatbelt';

describe('profile 生成（纯函数）', () => {
  const policy: SandboxPolicy = { workspace: '/tmp/ws-a', writableDirs: ['/tmp/home-a'], readableDirs: ['/opt/tool'], isolatedRoots: ['/tmp/apploom-gate'], denyPorts: [6379, 3001] };

  it('写只放行工作区与沙箱目录；读先拒家目录与其它租户根目录再放行自己的；拒绝信号与基础设施端口', () => {
    const p = buildSeatbeltProfile(policy);
    expect(p).toContain('(deny file-write*)');
    expect(p).toMatch(/\(allow file-write\* .*\/tmp\/ws-a.*\/tmp\/home-a/);
    expect(p).toMatch(/\(deny file-read-data \(subpath "\/Users"\) .*apploom-gate/);
    expect(p).toMatch(/\(allow file-read-data .*ws-a.*home-a.*\/opt\/tool/);
    expect(p).toContain('(deny signal)');
    expect(p).toContain('(remote ip "*:6379")');
    expect(p).toContain('(remote ip "*:3001")');
    // 规则后者优先：放行必须出现在拒绝之后
    expect(p.indexOf('(allow file-read-data')).toBeGreaterThan(p.indexOf('(deny file-read-data'));
  });

  it('路径含引号 / 反斜杠 / 换行时拒绝生成（防 profile 注入）', () => {
    for (const bad of ['/tmp/a"b', '/tmp/a\\b', '/tmp/a\nb']) {
      expect(() => buildSeatbeltProfile({ ...policy, workspace: bad })).toThrow(/非法字符/);
    }
  });

  it('wrap 把命令改写成 sandbox-exec -p <profile> <cmd> <args>', () => {
    const w = new SeatbeltExecutor().wrap(policy, { command: 'npm', args: ['install'] });
    expect(w.command).toBe('/usr/bin/sandbox-exec');
    expect(w.args[0]).toBe('-p');
    expect(w.args.slice(2)).toEqual(['npm', 'install']);
  });
});

describe('模式解析与启动自检', () => {
  it('SANDBOX_MODE 解析；off 不隔离；强制模式在不支持的平台直接报错；auto 退化为不隔离', () => {
    expect(sandboxMode({})).toBe('auto');
    expect(sandboxMode({ SANDBOX_MODE: 'SEATBELT' })).toBe('seatbelt');
    expect(sandboxMode({ SANDBOX_MODE: 'whatever' })).toBe('auto');
    expect(resolveExecutor({ SANDBOX_MODE: 'off' })).toBeNull();
    expect(() => resolveExecutor({ SANDBOX_MODE: 'seatbelt' }, 'linux')).toThrow(/拒绝在没有隔离/);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveExecutor({}, 'linux')).toBeNull();
    jest.restoreAllMocks();
  });

  it('基础设施端口：Redis / API / 数据库默认端口 + DATABASE_URL 端口 + 追加', () => {
    const ports = infraPorts({ REDIS_PORT: '6380', PORT: '4000', DATABASE_URL: 'mysql://u:p@h:3307/db', SANDBOX_DENY_PORTS: '9200, x' });
    expect(ports).toEqual(expect.arrayContaining([6380, 4000, 3306, 5432, 3307, 9200]));
    expect(ports).not.toContain(NaN);
  });

  it('只按变量名识别疑似密钥，不碰值；KEYTIMEOUT 之类不误报', () => {
    const names = findSecretEnvNames({ OPENAI_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'x', DATABASE_URL: 'x', REDIS_PASSWORD: 'x', KEYTIMEOUT: '1', PATH: '/bin', EMPTY_TOKEN: '' });
    expect(names).toEqual(['ANTHROPIC_AUTH_TOKEN', 'DATABASE_URL', 'OPENAI_API_KEY', 'REDIS_PASSWORD']);
  });
});

const darwin = SeatbeltExecutor.isAvailable() ? describe : describe.skip;

darwin('Seatbelt 真实隔离（真实进程）', () => {
  const rnd = Math.random().toString(36).slice(2, 8);
  const root = '/tmp/apploom-gate'; // 属于 ISOLATED_ROOTS
  const ws = path.join(root, `sbx-ws-${rnd}`);
  const otherDoc = path.join(root, `sbx-other-${rnd}`);
  const homeSecret = path.join(homedir(), `.apploom-sbx-secret-${rnd}`);
  const sbxHome = mkdtempSync('/tmp/apploom-sbx-home-');
  const outside = `/tmp/apploom-sbx-outside-${rnd}`;
  const env = { ...process.env, SANDBOX_HOME: sbxHome };

  beforeAll(() => {
    mkdirSync(ws, { recursive: true });
    mkdirSync(otherDoc, { recursive: true });
    writeFileSync(path.join(otherDoc, 'data.txt'), 'OTHER-DOC-SECRET');
    writeFileSync(path.join(ws, 'in.txt'), 'ws-content');
    writeFileSync(homeSecret, 'HOME-SECRET');
  });
  afterAll(() => {
    for (const p of [ws, otherDoc, homeSecret, sbxHome, outside]) rmSync(p, { recursive: true, force: true });
  });

  const exec = new SeatbeltExecutor();
  /** 在沙箱里跑命令，返回 stdout+stderr */
  const sh = (script: string, denyPorts: number[] = []) => {
    const policy = { ...buildPolicy(ws, env), denyPorts };
    const w = exec.wrap(policy, { command: '/bin/sh', args: ['-c', script] });
    const r = spawnSync(w.command, w.args, { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } });
    return { out: `${r.stdout}${r.stderr}`, code: r.status };
  };

  it('工作区可读写；工作区外与家目录不可写', () => {
    expect(sh(`cat ${ws}/in.txt && echo x > ${ws}/new.txt && echo wrote`).out).toContain('wrote');
    expect(existsSync(path.join(ws, 'new.txt'))).toBe(true);
    expect(sh(`echo x > ${outside}`).code).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
    expect(sh(`echo x > ${homeSecret}.w`).code).not.toBe(0);
  });

  it('家目录里的文件、其它 doc 的工作区读不到', () => {
    expect(sh(`cat ${homeSecret}`).out).not.toContain('HOME-SECRET');
    expect(sh(`cat ${path.join(otherDoc, 'data.txt')}`).out).not.toContain('OTHER-DOC-SECRET');
    expect(sh(`cat ${ws}/in.txt`).out).toContain('ws-content'); // 对照：自己的能读
  });

  it('多租户：自己租户的 HOME 可读写，其它租户的 HOME（含包管理器缓存）读不到也写不了', () => {
    const mine = sandboxHome(env, 'alice');
    const theirs = sandboxHome(env, 'bob');
    mkdirSync(mine, { recursive: true });
    mkdirSync(theirs, { recursive: true });
    writeFileSync(path.join(theirs, 'cache.txt'), 'BOB-CACHE');
    const tenantSh = (script: string) => {
      const w = exec.wrap(buildPolicy(ws, env, 'alice'), { command: '/bin/sh', args: ['-c', script] });
      const r = spawnSync(w.command, w.args, { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } });
      return { out: `${r.stdout}${r.stderr}`, code: r.status };
    };
    expect(tenantSh(`echo A > ${mine}/own.txt && cat ${mine}/own.txt`).out).toContain('A');
    expect(tenantSh(`cat ${theirs}/cache.txt`).out).not.toContain('BOB-CACHE');
    expect(tenantSh(`echo x > ${theirs}/poison.txt`).code).not.toBe(0);
    expect(existsSync(path.join(theirs, 'poison.txt'))).toBe(false);
  });

  it('不能给沙箱外的进程发信号；沙箱内自己的子进程可以', async () => {
    const marker = path.join(sbxHome, 'got-signal');
    const peer = spawn(process.execPath, ['-e', `process.on('SIGUSR2',()=>require('fs').writeFileSync(${JSON.stringify(marker)},'1'));setTimeout(()=>{},30000)`], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 600));
      sh(`/bin/kill -USR2 ${peer.pid}`);
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(marker)).toBe(false);
      expect(sh('sleep 30 & kill $! && echo killed-child').out).toContain('killed-child');
    } finally {
      peer.kill('SIGKILL');
    }
  });

  it('不能连被禁止的基础设施端口，其它端口照常可连', async () => {
    const listen = () =>
      new Promise<{ server: Server; port: number }>((resolve) => {
        const server = createServer((s) => s.end()).listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
      });
    const a = await listen();
    const b = await listen();
    try {
      expect(sh(`/usr/bin/nc -z -w2 127.0.0.1 ${a.port} && echo connected`, [a.port]).out).not.toContain('connected');
      expect(sh(`/usr/bin/nc -z -w2 127.0.0.1 ${b.port} && echo connected`, [a.port]).out).toContain('connected');
    } finally {
      a.server.close();
      b.server.close();
    }
  });

  it('端到端：sandboxContext + shell 工具——node 可运行、环境里无密钥、读不到家目录', async () => {
    process.env.TEST_SBX_FAKE_SECRET_KEY = 'leak-me';
    try {
      const sbx = sandboxContext(ws, {}, env);
      expect(sbx.executor).toBe('seatbelt');
      const tools = createDefaultRegistry();
      const run = (args: string[]) => tools.execute('shell', { command: process.execPath, args, cwd: ws, timeoutMs: 20000 }, { workspace: ws, env: sbx.env, wrap: sbx.wrap });
      const ok = await run(['-e', 'console.log("alive", process.env.TEST_SBX_FAKE_SECRET_KEY ?? "no-secret", process.env.HOME)']);
      expect(ok.output).toContain(`alive no-secret ${sbxHome}`);
      const denied = await run(['-e', `try{console.log(require("fs").readFileSync(${JSON.stringify(homeSecret)},"utf8"))}catch(e){console.log("denied",e.code)}`]);
      expect(denied.output).toContain('denied');
      expect(denied.output).not.toContain('HOME-SECRET');
      expect(readFileSync(path.join(ws, 'in.txt'), 'utf-8')).toBe('ws-content');
    } finally {
      delete process.env.TEST_SBX_FAKE_SECRET_KEY;
    }
  });
});
