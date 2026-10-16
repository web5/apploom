/**
 * 执行 LLM 生成代码时的最小环境变量。
 *
 * install 脚本（postinstall）、构建脚本、dev server 跑的都是不可信代码，若继承 API 进程的 process.env，
 * 就能直接读到 LLM / 数据库 / Redis 的密钥。这里改为白名单：只放行运行 node 工具链所必需的变量。
 * HOME 指向一个空目录，使 ~/.npmrc（可能带 registry token）、~/.ssh 等不会被工具链自动读取
 * ——注意这只是不让它「顺手」读到，不是文件系统隔离（那需要 OS 级沙箱 / 容器）。
 */
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';

/** 工具链运行必需、且不含机密的变量 */
const PASSTHROUGH = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  // 代理与私有源：企业网络下 npm install 离不开它们（凭据若写在 URL 里属于使用者自己的选择）
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
];

/** 沙箱进程的 HOME：空目录，缓存（npm / pnpm / yarn）也落在这里 */
export function sandboxHome(source: NodeJS.ProcessEnv = process.env): string {
  return source.SANDBOX_HOME ?? '/tmp/apploom-sandbox-home';
}

/** 额外放行的变量名（逗号分隔），用于确实需要的场景（如私有源的 NPM_TOKEN）；放行即视为对其泄漏负责 */
function extraAllowed(source: NodeJS.ProcessEnv): string[] {
  return (source.SANDBOX_ENV_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 构造子进程环境。source 默认取 process.env（测试可注入）；extra 是调用方指定的固定值
 * （如 BROWSER=none），优先级最高。
 */
export function sandboxEnv(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...PASSTHROUGH, ...extraAllowed(source)]) {
    const v = source[name];
    if (v !== undefined) env[name] = v;
  }
  const home = sandboxHome(source);
  mkdirSync(home, { recursive: true });
  env.HOME = home;
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_DATA_HOME = path.join(home, '.local/share');
  // 不沿用宿主的 TMPDIR（/var/folders/…，同用户其它应用的临时文件也在那里）
  env.TMPDIR = path.join(home, 'tmp');
  mkdirSync(env.TMPDIR, { recursive: true });
  return { ...env, ...extra };
}
