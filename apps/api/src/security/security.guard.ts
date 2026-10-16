/**
 * 全局守卫：认证 → 限流。
 *  - 认证失败按来源 IP 单独限流，防止暴力猜密钥
 *  - 已认证的请求按主体（API Key 名）限流；未启用认证时按 IP
 *  - POST /pipeline（创建流水线，直接消耗 token）用更严的额度
 */
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { authenticate, extractToken, parseApiKeys, type Principal } from './api-keys';
import { RateLimiter } from './rate-limiter';

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

type Req = {
  method: string;
  path?: string;
  url: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  principal?: Principal;
};
type Res = { setHeader(name: string, value: string | number): void };

export interface SecurityConfig {
  keys: ReturnType<typeof parseApiKeys>;
  perMin: number;
  createPerMin: number;
  authFailPerMin: number;
}

export function securityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const keys = parseApiKeys(env.API_KEYS);
  if (keys.length === 0 && env.AUTH_REQUIRED === '1') throw new Error('AUTH_REQUIRED=1 但没有配置 API_KEYS，拒绝启动（否则 API 会完全开放）');
  return {
    keys,
    perMin: num(env.RATE_LIMIT_PER_MIN, 240),
    createPerMin: num(env.RATE_LIMIT_CREATE_PER_MIN, 10),
    authFailPerMin: num(env.RATE_LIMIT_AUTH_FAIL_PER_MIN, 20),
  };
}

@Injectable()
export class SecurityGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger('Security');
  private readonly limiter = new RateLimiter();
  private readonly cfg = securityConfig();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    if (this.cfg.keys.length === 0) {
      this.logger.warn('未配置 API_KEYS：API 不做认证（仅限本机开发）。对外提供服务前请设置 API_KEYS，并用 AUTH_REQUIRED=1 防止漏配');
    } else {
      this.logger.log(`API Key 认证已启用（${this.cfg.keys.length} 个密钥）`);
    }
    this.sweeper = setInterval(() => this.limiter.sweep(), 60_000);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<Res>();
    const path = req.path ?? req.url.split('?')[0];
    if (req.method === 'OPTIONS' || path === '/') return true; // 预检与健康检查

    const ip = req.ip ?? 'unknown';
    if (this.cfg.keys.length > 0) {
      const principal = authenticate(this.cfg.keys, extractToken(req));
      if (!principal) {
        this.throttle(res, `authfail:${ip}`, this.cfg.authFailPerMin);
        throw new UnauthorizedException('缺少或无效的 API Key（Authorization: Bearer <key> 或 X-API-Key）');
      }
      req.principal = principal;
    }

    const who = req.principal?.name ? `key:${req.principal.name}` : `ip:${ip}`;
    const isCreate = req.method === 'POST' && path === '/pipeline';
    if (isCreate) this.throttle(res, `create:${who}`, this.cfg.createPerMin);
    this.throttle(res, `all:${who}`, this.cfg.perMin);
    return true;
  }

  private throttle(res: Res, key: string, limit: number): void {
    const r = this.limiter.hit(key, limit);
    if (r.allowed) return;
    res.setHeader('Retry-After', r.retryAfterSec);
    throw new HttpException({ statusCode: 429, message: `请求过于频繁，请 ${r.retryAfterSec} 秒后重试` }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
