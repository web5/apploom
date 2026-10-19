import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { freePort } from './local-deploy.service';

const ROOT = '/tmp/apploom-deploy';
const rnd = Math.random().toString(36).slice(2, 8);
const docA = `fp-a-${rnd}`;
const docB = `fp-b-${rnd}`;

const pickPort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

/** 在 ROOT/{doc} 下起一个真实监听进程（cwd 即部署目录，和真实 dev server 一样） */
async function listenerIn(doc: string, port: number): Promise<ChildProcess> {
  const cwd = path.join(ROOT, doc);
  mkdirSync(cwd, { recursive: true });
  const p = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`], { cwd, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await new Promise<boolean>((r) => { const c = require('node:net').connect(port, '127.0.0.1').once('connect', function (this: import('node:net').Socket) { this.destroy(); r(true); }).once('error', () => r(false)); })) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('监听进程没起来');
}
const alive = (p: ChildProcess) => { try { process.kill(p.pid!, 0); return true; } catch { return false; } };

describe('freePort：多用户下只终止自己这条流水线的旧 dev server', () => {
  const procs: ChildProcess[] = [];
  afterAll(() => {
    for (const p of procs) p.kill('SIGKILL');
    rmSync(path.join(ROOT, docA), { recursive: true, force: true });
    rmSync(path.join(ROOT, docB), { recursive: true, force: true });
  });

  it('同一 doc 重新部署：终止自己的旧进程；别的 doc 的预览占着端口：不终止、不请求审批', async () => {
    const mine = await pickPort();
    const a = await listenerIn(docA, mine);
    procs.push(a);
    const approve = jest.fn(async () => 'rejected' as const);
    expect(await freePort(mine, docA, () => undefined, approve)).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(a)).toBe(false);
    expect(approve).not.toHaveBeenCalled();

    const shared = await pickPort();
    const b = await listenerIn(docB, shared);
    procs.push(b);
    const logs: string[] = [];
    expect(await freePort(shared, docA, (l) => logs.push(l), approve)).toBeNull();
    expect(alive(b)).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('另一条流水线');
  }, 20000);

  it('只看监听该端口的进程：连着这个端口的客户端（如浏览器）不是占用者，不会被当成要终止的对象或触发审批', async () => {
    const port = await pickPort();
    const listener = await listenerIn(docA, port);
    procs.push(listener);
    const client = spawn(process.execPath, ['-e', `require('net').connect(${port},'127.0.0.1');setInterval(()=>{},1000)`], { cwd: '/tmp', stdio: 'ignore' });
    procs.push(client);
    await new Promise((r) => setTimeout(r, 500));
    const approve = jest.fn(async () => 'rejected' as const);
    expect(await freePort(port, docA, () => undefined, approve)).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(listener)).toBe(false);
    expect(alive(client)).toBe(true);
    expect(approve).not.toHaveBeenCalled();
  }, 20000);
});
