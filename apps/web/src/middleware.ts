/**
 * 后端启用了 API_KEYS 认证后，Studio 的 /api 请求需要带密钥。浏览器不能持有它，
 * 所以在 Next 服务端的中间件里注入：API_KEY 没有 NEXT_PUBLIC_ 前缀，不会被打进前端代码。
 *
 * 注意：这等于「能访问 Studio 的人共用同一个 API Key」，只是把现有的开放程度原样保留；
 * 真正的多用户需要登录与按用户签发的凭证。
 */
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const key = process.env.API_KEY;
  if (!key) return NextResponse.next();
  const headers = new Headers(req.headers);
  headers.set('authorization', `Bearer ${key}`);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: '/api/:path*' };
