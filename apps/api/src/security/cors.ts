/**
 * CORS 白名单。浏览器里的任意网页都能向 localhost:3001 发请求，全开 CORS 等于让它们能读写你的流水线，
 * 所以默认只放行本机前端开发地址；生产用 CORS_ORIGINS（逗号分隔）显式列出。
 * Studio 经 Next 的 /api 代理访问后端，是同源请求，不依赖 CORS。
 */
const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ORIGINS;
}
