import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { authenticate, extractToken, parseApiKeys } from './api-keys';
import { corsOrigins } from './cors';
import { RateLimiter } from './rate-limiter';
import { SecurityGuard, securityConfig } from './security.guard';

describe('api-keys', () => {
  it('解析 name:key / 纯 key；空密钥直接报错', () => {
    const keys = parseApiKeys('alice:sk-aaa, sk-bbbbbbbb ,ci:sk:with:colons');
    expect(keys.map((k) => k.name)).toEqual(['alice', 'sk-bbb', 'ci']);
    expect(authenticate(keys, 'sk-aaa')).toEqual({ name: 'alice' });
    expect(authenticate(keys, 'sk-bbbbbbbb')).toEqual({ name: 'sk-bbb' });
    expect(authenticate(keys, 'sk:with:colons')).toEqual({ name: 'ci' });
    expect(authenticate(keys, 'sk-aa')).toBeNull();
    expect(authenticate(keys, undefined)).toBeNull();
    expect(parseApiKeys('')).toEqual([]);
    expect(() => parseApiKeys('alice:')).toThrow(/空密钥/);
  });

  it('取密钥：Bearer / X-API-Key；?api_key= 只对 GET 生效', () => {
    expect(extractToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
    expect(extractToken({ headers: { 'x-api-key': 'k1' } })).toBe('k1');
    expect(extractToken({ method: 'GET', headers: {}, query: { api_key: 'q' } })).toBe('q');
    expect(extractToken({ method: 'POST', headers: {}, query: { api_key: 'q' } })).toBeUndefined();
    expect(extractToken({ headers: {} })).toBeUndefined();
  });
});

describe('RateLimiter', () => {
  it('固定窗口：超限被拒并给出重试秒数；窗口过后恢复；sweep 清理过期项', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    expect([1, 2, 3].map(() => rl.hit('k', 3).allowed)).toEqual([true, true, true]);
    t = 20_000;
    const denied = rl.hit('k', 3);
    expect(denied).toEqual({ allowed: false, retryAfterSec: 40 });
    expect(rl.hit('other', 3).allowed).toBe(true); // 不同 key 互不影响
    t = 60_000;
    expect(rl.hit('k', 3).allowed).toBe(true);
    t = 200_000;
    expect(rl.sweep()).toBe(2);
    expect(rl.size).toBe(0);
    expect(rl.hit('k', 0).allowed).toBe(true); // limit<=0 = 不限
  });
});

describe('配置', () => {
  it('AUTH_REQUIRED=1 但没配密钥：拒绝启动，而不是悄悄全开', () => {
    expect(() => securityConfig({ AUTH_REQUIRED: '1' })).toThrow(/拒绝启动/);
    expect(securityConfig({ API_KEYS: 'a:b', AUTH_REQUIRED: '1' }).keys).toHaveLength(1);
  });

  it('CORS 默认只放行本机前端；CORS_ORIGINS 可覆盖', () => {
    expect(corsOrigins({})).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(corsOrigins({ CORS_ORIGINS: 'https://a.com, https://b.com' })).toEqual(['https://a.com', 'https://b.com']);
  });
});

@Controller()
class StubController {
  @Get() health() { return 'ok'; }
  @Post('pipeline') create() { return { id: 'x' }; }
  @Get('pipeline/:id') get() { return { id: 'x' }; }
}

describe('SecurityGuard + CORS（真实 HTTP）', () => {
  const saved = { ...process.env };
  let app: INestApplication;

  async function boot(env: Record<string, string>) {
    Object.assign(process.env, env);
    const mod = await Test.createTestingModule({ controllers: [StubController], providers: [{ provide: APP_GUARD, useClass: SecurityGuard }] }).compile();
    app = mod.createNestApplication();
    app.enableCors({ origin: corsOrigins() });
    await app.init();
    return request(app.getHttpServer());
  }
  beforeEach(() => {
    process.env = { ...saved };
    delete process.env.API_KEYS;
    delete process.env.AUTH_REQUIRED;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await app?.close();
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  it('未配置 API_KEYS：不做认证（本机开发）', async () => {
    const api = await boot({});
    await api.get('/pipeline/x').expect(200);
    await api.post('/pipeline').expect(201);
  });

  it('配置了密钥：无密钥 / 错误密钥 401；Bearer、X-API-Key 通过；健康检查 / 公开', async () => {
    const api = await boot({ API_KEYS: 'alice:sk-good' });
    await api.get('/pipeline/x').expect(401);
    await api.get('/pipeline/x').set('Authorization', 'Bearer sk-bad').expect(401);
    await api.get('/pipeline/x').set('Authorization', 'Bearer sk-good').expect(200);
    await api.get('/pipeline/x').set('X-API-Key', 'sk-good').expect(200);
    await api.get('/').expect(200);
  });

  it('?api_key= 只允许 GET（给 EventSource 用）；POST 带它仍是 401', async () => {
    const api = await boot({ API_KEYS: 'alice:sk-good' });
    await api.get('/pipeline/x?api_key=sk-good').expect(200);
    await api.post('/pipeline?api_key=sk-good').expect(401);
  });

  it('暴力猜密钥：同一来源连续失败超过额度后返回 429 + Retry-After', async () => {
    const api = await boot({ API_KEYS: 'alice:sk-good', RATE_LIMIT_AUTH_FAIL_PER_MIN: '3' });
    for (let i = 0; i < 3; i++) await api.get('/pipeline/x').set('Authorization', 'Bearer guess').expect(401);
    const r = await api.get('/pipeline/x').set('Authorization', 'Bearer guess').expect(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    await api.get('/pipeline/x').set('Authorization', 'Bearer sk-good').expect(200); // 正确密钥不受失败额度影响
  });

  it('创建流水线用更严的额度，超限只影响创建，不影响读取', async () => {
    const api = await boot({ API_KEYS: 'alice:sk-good', RATE_LIMIT_CREATE_PER_MIN: '2' });
    const auth = { Authorization: 'Bearer sk-good' };
    await api.post('/pipeline').set(auth).expect(201);
    await api.post('/pipeline').set(auth).expect(201);
    const r = await api.post('/pipeline').set(auth).expect(429);
    expect(r.headers['retry-after']).toBeDefined();
    await api.get('/pipeline/x').set(auth).expect(200);
  });

  it('总额度按密钥名隔离：一个主体打满不影响另一个', async () => {
    const api = await boot({ API_KEYS: 'alice:sk-a,bob:sk-b', RATE_LIMIT_PER_MIN: '2' });
    await api.get('/pipeline/x').set('X-API-Key', 'sk-a').expect(200);
    await api.get('/pipeline/x').set('X-API-Key', 'sk-a').expect(200);
    await api.get('/pipeline/x').set('X-API-Key', 'sk-a').expect(429);
    await api.get('/pipeline/x').set('X-API-Key', 'sk-b').expect(200);
  });

  it('CORS：白名单外的来源拿不到 Access-Control-Allow-Origin；白名单内的可以', async () => {
    const api = await boot({ CORS_ORIGINS: 'https://studio.example.com' });
    const evil = await api.get('/').set('Origin', 'https://evil.example.com');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await api.get('/').set('Origin', 'https://studio.example.com');
    expect(ok.headers['access-control-allow-origin']).toBe('https://studio.example.com');
  });
});
