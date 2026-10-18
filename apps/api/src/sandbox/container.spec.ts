import { ContainerExecutor, containerOptions, isContainerAvailable } from './container';
import { resolveExecutor, sandboxMode } from './sandbox';

const opts = { ...containerOptions({}), uid: 1000, gid: 1000 };
const policy = { workspace: '/tmp/apploom-deploy/d1', writableDirs: ['/tmp/apploom-sandbox-home/t-alice-1'], readableDirs: ['/opt/node'], env: { PATH: '/usr/bin', HOME: '/tmp/apploom-sandbox-home/t-alice-1' } };

describe('容器执行器的命令构造', () => {
  const w = new ContainerExecutor(opts).wrap(policy, { command: 'npm', args: ['install', '--no-audit'] });
  const joined = w.args.join(' ');

  it('一次性、只读根文件系统、丢弃全部 capability、禁止提权、限制资源、非 root 用户', () => {
    expect(w.command).toBe('docker');
    expect(w.args.slice(0, 3)).toEqual(['run', '--rm', '-i']);
    for (const frag of ['--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--memory 2g', '--cpus 2', '--pids-limit 512', '--network bridge', '--user 1000:1000']) expect(joined).toContain(frag);
  });

  it('只挂载工作区与租户 HOME（读写）、工具链目录（只读），工作目录是工作区；命令在镜像之后', () => {
    expect(joined).toContain('-v /tmp/apploom-deploy/d1:/tmp/apploom-deploy/d1:rw');
    expect(joined).toContain('-v /tmp/apploom-sandbox-home/t-alice-1:/tmp/apploom-sandbox-home/t-alice-1:rw');
    expect(joined).toContain('-v /opt/node:/opt/node:ro');
    expect(joined).toContain('-w /tmp/apploom-deploy/d1');
    expect(w.args.slice(-4)).toEqual(['node:20-bookworm-slim', 'npm', 'install', '--no-audit']);
    expect(joined).not.toContain('/Users');
  });

  it('白名单环境变量显式带入；gVisor 通过 --runtime runsc 启用', () => {
    expect(joined).toContain('-e PATH=/usr/bin');
    const g = new ContainerExecutor({ ...opts, runtime: 'runsc' });
    expect(g.name).toBe('container(runsc)');
    expect(g.wrap(policy, { command: 'node', args: [] }).args.join(' ')).toContain('--runtime runsc');
  });

  it('挂载路径或环境变量里有会改变语义的字符时拒绝生成（防参数注入）', () => {
    const ex = new ContainerExecutor(opts);
    expect(() => ex.wrap({ ...policy, workspace: '/tmp/a:/etc' }, { command: 'x', args: [] })).toThrow(/非法字符/);
    expect(() => ex.wrap({ ...policy, env: { 'A B': '1' } }, { command: 'x', args: [] })).toThrow(/环境变量非法/);
    expect(() => ex.wrap({ ...policy, env: { A: 'x\ny' } }, { command: 'x', args: [] })).toThrow(/环境变量非法/);
  });
});

describe('SANDBOX_MODE=container', () => {
  it('可解析；引擎不可用时直接报错，而不是退化成裸跑', () => {
    expect(sandboxMode({ SANDBOX_MODE: 'container' })).toBe('container');
    // 本机没有 docker（或没起守护进程）时：探测失败 → 报错
    if (!isContainerAvailable('docker')) {
      expect(() => resolveExecutor({ SANDBOX_MODE: 'container' })).toThrow(/拒绝在没有隔离/);
    } else {
      expect(resolveExecutor({ SANDBOX_MODE: 'container' })).toBeInstanceOf(ContainerExecutor);
    }
  });
});
