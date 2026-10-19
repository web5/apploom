import { checkStructure, clipOutput, formatFailures, summarizeTscOutput, CodegenInput } from './codegen-gate';

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

describe('checkStructure · Prisma 单行块', () => {
  const withSchema = (content: string) => base({ files: [...base().files, { path: 'prisma/schema.prisma', content }] });

  it('拦下真实失败案例里的写法（generator / datasource 写成单行），并指出行号和块名', () => {
    const bad = 'generator client { provider = "prisma-client-js" }\ndatasource db { provider = "postgresql" url = env("DATABASE_URL") }\n\nmodel User {\n  id String @id\n}\n';
    const msgs = checkStructure(withSchema(bad)).map((f) => f.message);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('prisma/schema.prisma 第 1 行');
    expect(msgs[0]).toContain('generator client');
    expect(msgs[1]).toContain('第 2 行');
    expect(msgs[1]).toContain('datasource db');
  });

  it('单行 model 也拦（prisma validate 实测同样报错）；多行写法与普通 TS 文件不受影响', () => {
    expect(checkStructure(withSchema('model A { id String @id }\n'))).toHaveLength(1);
    const good = 'generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\nmodel A {\n  id String @id\n}\n';
    expect(checkStructure(withSchema(good))).toEqual([]);
    expect(checkStructure(base({ files: [...base().files, { path: 'src/x.ts', content: 'model A { id }' }] }))).toEqual([]);
  });
});

describe('summarizeTscOutput', () => {
  const nestErrors = [
    'server/src/tasks/tasks.controller.ts(8,3): error TS1241: Unable to resolve signature of method decorator when called as an expression.',
    '  The runtime will invoke the decorator with 2 arguments, but the decorator expects 3.',
    'server/src/tasks/tasks.controller.ts(9,11): error TS1206: Decorators are not valid here.',
    'server/src/users/users.controller.ts(8,3): error TS1241: Unable to resolve signature of method decorator when called as an expression.',
    'server/src/app.module.ts(4,2): error TS1241: Unable to resolve signature of method decorator when called as an expression.',
    'server/src/main.ts(1,1): error TS1241: Unable to resolve signature of method decorator when called as an expression.',
  ].join('\n');

  it('同一错误码归并计数，并给出装饰器根因提示（根 tsconfig 才是 tsc --noEmit 用的）', () => {
    const out = summarizeTscOutput(nestErrors);
    expect(out).toContain('共 5 条');
    expect(out).toMatch(/TS1241 ×4（.*等 4 个文件）/);
    expect(out).toContain('experimentalDecorators');
    expect(out).toContain('根」tsconfig.json');
    expect(out).toContain('原始输出（节选）');
  });

  it('TS2307 提示依赖要写进根 package.json；没有可解析的错误行时退回原始输出', () => {
    expect(summarizeTscOutput("src/a.ts(1,8): error TS2307: Cannot find module 'zustand'.")).toContain('根」package.json');
    expect(summarizeTscOutput('error: something else entirely')).toBe('error: something else entirely');
  });
});

describe('checkStructure · 项目根目录', () => {
  it('没有根 package.json 但有子包 / 用 npm 启动：直接拦下（否则会被当成静态产物跳过全部校验）', () => {
    const files = [{ path: 'frontend/package.json', content: pkg() }, { path: 'backend/package.json', content: pkg() }];
    const f = checkStructure(base({ files, runCommand: 'npm run dev' }));
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('缺少根目录的 package.json');
    expect(f[0].message).toContain('frontend/package.json');
    expect(checkStructure(base({ files: [{ path: 'src/a.ts', content: 'x' }], runCommand: 'npm start' }))).toHaveLength(1);
  });

  it('真正的静态产物（无 package.json、不用 npm 启动）照旧放行', () => {
    expect(checkStructure(base({ files: [{ path: 'index.html', content: '<html></html>' }], dependencies: [], runCommand: 'python3 -m http.server 8080' }))).toEqual([]);
  });

  it('依赖只写在子目录 package.json：指出这一点；完全没写则提示补进根或删除', () => {
    const files = [
      { path: 'package.json', content: pkg() },
      { path: 'server/package.json', content: JSON.stringify({ dependencies: { '@nestjs/core': '^10' } }) },
    ];
    const msg = checkStructure(base({ files, dependencies: ['react@^18', '@nestjs/core@^10', 'rxjs@^7'] }))[0].message;
    expect(msg).toContain('@nestjs/core 只写在子目录的 package.json');
    expect(msg).toContain('rxjs');
    expect(checkStructure(base({ dependencies: ['react@^18', 'ghost@1'] }))[0].message).toContain('从 dependencies 列表里删掉');
  });
});
