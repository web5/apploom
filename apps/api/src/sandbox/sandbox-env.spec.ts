import { createDefaultRegistry } from '@apploom/tools';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { sandboxEnv } from './sandbox-env';

const fakeHome = mkdtempSync(path.join(tmpdir(), 'sbx-home-'));
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

describe('sandboxEnv：只放行工具链必需的变量', () => {
  const source = {
    PATH: '/usr/bin',
    LANG: 'zh_CN.UTF-8',
    HTTPS_PROXY: 'http://proxy:8080',
    HUNYUAN_API_KEY: 'sk-secret',
    DATABASE_URL: 'mysql://root:pw@db/x',
    REDIS_PASSWORD: 'redis-pw',
    NPM_TOKEN: 'npm-secret',
    HOME: '/Users/someone',
    SANDBOX_HOME: fakeHome,
  };

  it('密钥类变量一律不带，白名单变量保留，HOME 指向沙箱目录', () => {
    const env = sandboxEnv({}, source);
    expect(env).toMatchObject({ PATH: '/usr/bin', LANG: 'zh_CN.UTF-8', HTTPS_PROXY: 'http://proxy:8080', HOME: fakeHome });
    for (const k of ['HUNYUAN_API_KEY', 'DATABASE_URL', 'REDIS_PASSWORD', 'NPM_TOKEN']) expect(env).not.toHaveProperty(k);
    expect(JSON.stringify(env)).not.toMatch(/sk-secret|redis-pw|npm-secret|someone/);
  });

  it('SANDBOX_ENV_ALLOW 可显式放行额外变量；extra 优先级最高', () => {
    const env = sandboxEnv({ BROWSER: 'none', LANG: 'C' }, { ...source, SANDBOX_ENV_ALLOW: 'NPM_TOKEN, MISSING' });
    expect(env).toMatchObject({ NPM_TOKEN: 'npm-secret', BROWSER: 'none', LANG: 'C' });
    expect(env).not.toHaveProperty('MISSING');
  });
});

describe('shell 工具：真实子进程', () => {
  const tools = createDefaultRegistry();
  beforeEach(() => {
    process.env.TEST_FAKE_SECRET_KEY = 'leak-me';
  });
  afterEach(() => {
    delete process.env.TEST_FAKE_SECRET_KEY;
  });

  const printEnv = ['-e', 'console.log(JSON.stringify(process.env))'];

  it('对照：不传 env 时子进程能读到 API 进程里的密钥（说明下面的断言有区分度）', async () => {
    const r = await tools.execute('shell', { command: 'node', args: printEnv, cwd: fakeHome }, { workspace: fakeHome });
    expect(JSON.parse(r.output).TEST_FAKE_SECRET_KEY).toBe('leak-me');
  });

  it('传入 sandboxEnv() 后，子进程读不到密钥，HOME 是沙箱目录', async () => {
    const r = await tools.execute(
      'shell',
      { command: process.execPath, args: printEnv, cwd: fakeHome },
      { workspace: fakeHome, env: sandboxEnv({}, { ...process.env, SANDBOX_HOME: fakeHome }) },
    );
    const seen = JSON.parse(r.output) as Record<string, string>;
    expect(seen.TEST_FAKE_SECRET_KEY).toBeUndefined();
    expect(seen.HOME).toBe(fakeHome);
    expect(seen.PATH).toBeTruthy();
    expect(seen.CI).toBe('1');
  });

  it('超时 SIGKILL 整个进程组：命令派生的后台孙进程也会被杀掉', async () => {
    const r = await tools.execute(
      'shell',
      { command: 'sh', args: ['-c', 'sleep 60 & echo $!; wait'], cwd: fakeHome, timeoutMs: 600 },
      { workspace: fakeHome },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时/);
    const grandchild = Number(r.output.trim().split('\n')[0]);
    expect(grandchild).toBeGreaterThan(1);
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(grandchild, 0)).toThrow(); // ESRCH：已不存在
  });
});
