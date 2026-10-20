import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import * as path from 'node:path';
import { allocatePort, deployBasePort } from './local-deploy.service';

const ROOT = '/tmp/apploom-deploy';
const rnd = Math.random().toString(36).slice(2, 8);
const docA = `ap-a-${rnd}`;
const docB = `ap-b-${rnd}`;

/** 找一个连续空闲的端口段起点，避免和机器上的其它服务撞 */
async function freeBase(): Promise<number> {
  for (let base = 41000 + Math.floor(Math.random() * 2000); ; base += 10) {
    const ok = await Promise.all([0, 1, 2, 3].map((i) => new Promise<boolean>((r) => { const s = createServer().once('error', () => r(false)).listen(base + i, '0.0.0.0', () => s.close(() => r(true))); })));
    if (ok.every(Boolean)) return base;
  }
}

const reachable = (port: number) => new Promise<boolean>((r) => { connect(port, '127.0.0.1').once('connect', function (this: import('node:net').Socket) { this.destroy(); r(true); }).once('error', () => r(false)); });

/** 起一个真实监听进程；cwd 决定它是不是「某条流水线的 dev server」 */
async function listenerIn(cwd: string, port: number): Promise<ChildProcess> {
  mkdirSync(cwd, { recursive: true });
  const p = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'0.0.0.0');setInterval(()=>{},1000)`], { cwd, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await reachable(port)) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('监听进程没起来');
}
const alive = (p: ChildProcess) => { try { process.kill(p.pid!, 0); return true; } catch { return false; } };

describe('deployBasePort', () => {
  it('默认 7000；DEPLOY_BASE_PORT 可改；非法值回落到 7000', () => {
    expect(deployBasePort({})).toBe(7000);
    expect(deployBasePort({ DEPLOY_BASE_PORT: '6100' })).toBe(6100);
    for (const bad of ['abc', '80', '70000', '7000.5']) expect(deployBasePort({ DEPLOY_BASE_PORT: bad })).toBe(7000);
  });
});

describe('allocatePort：平台统一从基准端口起分配', () => {
  const procs: ChildProcess[] = [];
  afterEach(() => { for (const p of procs.splice(0)) p.kill('SIGKILL'); });
  afterAll(() => { for (const d of [docA, docB]) rmSync(path.join(ROOT, d), { recursive: true, force: true }); });

  it('基准端口空闲就用基准端口', async () => {
    const base = await freeBase();
    expect(await allocatePort(docA, () => undefined, base)).toBe(base);
  });

  it('基准端口被无关进程占着（如 macOS 的 AirPlay 占 7000）：不终止它、不要审批，顺延到下一个', async () => {
    const base = await freeBase();
    const stranger = await listenerIn('/tmp', base);
    procs.push(stranger);
    const logs: string[] = [];
    expect(await allocatePort(docA, (l) => logs.push(l), base)).toBe(base + 1);
    expect(alive(stranger)).toBe(true);
    expect(logs.join('\n')).toContain('不终止');
  }, 20000);

  it('别的流水线的预览占着：保留它，自己用下一个端口；多条流水线依次得到不同端口', async () => {
    const base = await freeBase();
    const b = await listenerIn(path.join(ROOT, docB), base);
    procs.push(b);
    expect(await allocatePort(docA, () => undefined, base)).toBe(base + 1);
    expect(alive(b)).toBe(true);
  }, 20000);

  it('同一条流水线重新部署：终止自己上一次的 dev server，并复用它的端口', async () => {
    const base = await freeBase();
    const old = await listenerIn(path.join(ROOT, docA), base);
    procs.push(old);
    const logs: string[] = [];
    expect(await allocatePort(docA, (l) => logs.push(l), base)).toBe(base);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(old)).toBe(false);
    expect(logs.join('\n')).toContain('上一次部署');
  }, 20000);

  it('只看监听者：连着基准端口的客户端（如浏览器）不算占用者', async () => {
    const base = await freeBase();
    const listener = await listenerIn(path.join(ROOT, docA), base);
    procs.push(listener);
    const client = spawn(process.execPath, ['-e', `require('net').connect(${base},'127.0.0.1');setInterval(()=>{},1000)`], { cwd: '/tmp', stdio: 'ignore' });
    procs.push(client);
    await new Promise((r) => setTimeout(r, 400));
    expect(await allocatePort(docA, () => undefined, base)).toBe(base);
    expect(alive(client)).toBe(true);
  }, 20000);
});
