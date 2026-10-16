import { checkStructure, formatFailures, CodegenInput } from './codegen-gate';

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
