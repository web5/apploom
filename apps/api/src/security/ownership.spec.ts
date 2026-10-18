import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { OwnerGuard } from './owner.guard';
import { canAccess, checkQuota, quotaConfig } from './ownership';

const alice = { name: 'alice' };

describe('归属判断', () => {
  it('未启用认证：不检查；启用后只能访问自己的与无归属的老数据', () => {
    expect(canAccess({ ownerId: 'bob' }, undefined)).toBe(true);
    expect(canAccess({ ownerId: 'alice' }, alice)).toBe(true);
    expect(canAccess({}, alice)).toBe(true);
    expect(canAccess({ ownerId: 'bob' }, alice)).toBe(false);
  });
});

describe('配额', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const run = (ownerId: string, status: string, hoursAgo = 1) => ({ ownerId, status, createdAt: new Date(now - hoursAgo * 3600_000).toISOString() }) as never;

  it('默认值：启用认证时 3 并发 / 30 每日，未启用认证不限', () => {
    expect(quotaConfig(true, {})).toEqual({ maxActive: 3, maxPerDay: 30 });
    expect(quotaConfig(false, {})).toEqual({ maxActive: 0, maxPerDay: 0 });
    expect(quotaConfig(true, { OWNER_MAX_ACTIVE_RUNS: '1', OWNER_MAX_RUNS_PER_DAY: '0' })).toEqual({ maxActive: 1, maxPerDay: 0 });
  });

  it('并发上限只数自己在跑的；等待确认的不占名额', () => {
    const cfg = { maxActive: 2, maxPerDay: 0 };
    const mine = [run('alice', 'running'), run('alice', 'waiting_confirm'), run('bob', 'running'), run('bob', 'running')];
    expect(checkQuota(mine, 'alice', cfg, now)).toBeNull();
    expect(checkQuota([...mine, run('alice', 'created')], 'alice', cfg, now)).toMatch(/同时运行/);
  });

  it('每日上限按最近 24 小时滚动统计', () => {
    const cfg = { maxActive: 0, maxPerDay: 2 };
    expect(checkQuota([run('alice', 'completed', 2), run('alice', 'completed', 30)], 'alice', cfg, now)).toBeNull();
    expect(checkQuota([run('alice', 'completed', 2), run('alice', 'failed', 23)], 'alice', cfg, now)).toMatch(/24 小时/);
  });
});

describe('OwnerGuard', () => {
  const ctx = (req: object) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;
  const guard = (doc: object | null) => new OwnerGuard({ get: async () => doc } as never);

  it('他人的流水线按不存在处理；自己的、不存在的 id、没有 :id 的路由放行', async () => {
    await expect(guard({ ownerId: 'bob' }).canActivate(ctx({ params: { id: 'x' }, principal: alice }))).rejects.toBeInstanceOf(NotFoundException);
    await expect(guard({ ownerId: 'alice' }).canActivate(ctx({ params: { id: 'x' }, principal: alice }))).resolves.toBe(true);
    await expect(guard(null).canActivate(ctx({ params: { id: 'x' }, principal: alice }))).resolves.toBe(true);
    await expect(guard({ ownerId: 'bob' }).canActivate(ctx({ params: {}, principal: alice }))).resolves.toBe(true);
  });

  it('未启用认证时不查库直接放行', async () => {
    const get = jest.fn();
    await expect(new OwnerGuard({ get } as never).canActivate(ctx({ params: { id: 'x' } }))).resolves.toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
