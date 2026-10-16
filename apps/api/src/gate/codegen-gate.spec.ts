import { checkStructure, clipOutput, formatFailures, CodegenInput } from './codegen-gate';

const pkg = (extra: object = {}) =>
  JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^18' }, devDependencies: { vite: '^5' }, ...extra });

const base = (over: Partial<CodegenInput> = {}): CodegenInput => ({
  files: [
    { path: 'package.json', content: pkg() },
    { path: 'src/App.tsx', content: 'export default () => null;' },
  ],
  dependencies: ['react@^18', 'vite@^5'],
  runCommand: 'npm run dev',
  ...over,
});

describe('checkStructure', () => {
  it('合法产物无失败', () => {
    expect(checkStructure(base())).toEqual([]);
  });

  it('files 为空', () => {
    expect(checkStructure(base({ files: [] }))[0].message).toContain('files 为空');
  });

  it('拦截绝对路径、.. 路径、重复路径、空内容', () => {
    const f = checkStructure(
      base({
        files: [
          { path: '/etc/passwd', content: 'x' },
          { path: '../a.ts', content: 'x' },
          { path: 'a.ts', content: 'x' },
          { path: 'a.ts', content: 'y' },
          { path: 'b.ts', content: '  ' },
        ],
      }),
    );
    const msgs = f.map((x) => x.message).join('\n');
    expect(msgs).toContain('相对路径');
    expect(msgs).toContain('".."');
    expect(msgs).toContain('重复');
    expect(msgs).toContain('内容为空');
  });

  it('package.json 非法 JSON', () => {
    const f = checkStructure(base({ files: [{ path: 'package.json', content: '{oops' }] }));
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('不是合法 JSON');
  });

  it('dependencies 与 package.json 不一致（含 scope 包）', () => {
    const f = checkStructure(base({ dependencies: ['react@^18', '@prisma/client@5', 'zod'] }));
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('@prisma/client, zod');
  });

  it('runCommand 指向不存在的 script', () => {
    const f = checkStructure(base({ runCommand: 'pnpm run serve' }));
    expect(f[0].message).toContain('"serve"');
  });

  it('npm start 无 start 脚本时不报错；组合命令不做 script 检查', () => {
    expect(checkStructure(base({ runCommand: 'npm start' }))).toEqual([]);
    expect(checkStructure(base({ runCommand: 'npm run build && npm run preview' }))).toEqual([]);
  });

  it('无 package.json 的静态产物只做路径检查', () => {
    expect(checkStructure({ files: [{ path: 'index.html', content: '<html/>' }], dependencies: [], runCommand: 'npx serve' })).toEqual([]);
  });
});

describe('formatFailures', () => {
  it('编号并带上 detail', () => {
    const text = formatFailures([
      { check: 'build', message: 'build 失败', detail: 'error TS2304' },
      { check: 'structure', message: '路径重复' },
    ]);
    expect(text).toContain('1. [build] build 失败\nerror TS2304');
    expect(text).toContain('2. [structure] 路径重复');
  });
});

describe('checkStructure: tsc 需要 tsconfig.json', () => {
  const withScripts = (scripts: Record<string, string>, extraFiles: { path: string; content: string }[] = []): CodegenInput => ({
    files: [{ path: 'package.json', content: JSON.stringify({ scripts, dependencies: {}, devDependencies: {} }) }, { path: 'src/a.ts', content: 'export {}' }, ...extraFiles],
    dependencies: [],
    runCommand: 'npm run dev',
  });

  it.each(['tsc && vite build', 'tsc', 'vite build && tsc --noEmit', 'npm run lint; tsc -p .'])('脚本 "%s" 用到 tsc 但缺 tsconfig.json → 失败', (build) => {
    const f = checkStructure(withScripts({ dev: 'vite', build }));
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('没有生成 tsconfig.json');
  });

  it('有 tsconfig.json 则通过', () => {
    expect(checkStructure(withScripts({ dev: 'vite', build: 'tsc && vite build' }, [{ path: 'tsconfig.json', content: '{}' }]))).toEqual([]);
  });

  it.each(['vite build', 'tsc-watch --onSuccess x', 'ts-node src/a.ts', 'node tsconfig-paths.js'])('不含独立的 tsc 命令的脚本 "%s" 不误报', (build) => {
    expect(checkStructure(withScripts({ dev: 'vite', build }))).toEqual([]);
  });
});

describe('clipOutput', () => {
  const long = (n: number, ch: string) => ch.repeat(n);

  it('未超长原样返回（去首尾空白）', () => {
    expect(clipOutput('  abc \n', 'both')).toBe('abc');
  });

  it('head / tail 只保留一端', () => {
    const text = `HEAD${long(5000, 'x')}TAIL`;
    expect(clipOutput(text, 'head')).toContain('HEAD');
    expect(clipOutput(text, 'head')).not.toContain('TAIL');
    expect(clipOutput(text, 'tail')).toContain('TAIL');
    expect(clipOutput(text, 'tail')).not.toContain('HEAD');
  });

  it('both 同时保留开头的真正报错和结尾的汇总，中间被刷屏内容淹没的部分省略', () => {
    const text = `error TS2307: Cannot find module './a.css'${long(6000, '\nhelp line')}\nBuild failed with 1 error`;
    const out = clipOutput(text, 'both');
    expect(out).toContain('error TS2307');
    expect(out).toContain('Build failed with 1 error');
    expect(out).toMatch(/中间省略 \d+ 字符/);
    expect(out.length).toBeLessThan(4200);
  });
});
