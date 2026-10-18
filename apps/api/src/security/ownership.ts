/**
 * 多用户：流水线归属与配额。
 *
 * 归属：创建时记下 API Key 名（ownerId）。只在启用认证（请求带 principal）时检查；
 * 没有 ownerId 的老数据视为公共（升级前的开发数据），所有已认证用户可见。
 * 访问他人的流水线一律返回 404，不泄露「存在但无权访问」。
 *
 * 配额（超出返回 429）：同时在跑的流水线数、24 小时内新建数。0 = 不限。
 * 启用认证时默认 3 / 30（OWNER_MAX_ACTIVE_RUNS / OWNER_MAX_RUNS_PER_DAY 可覆盖）；未启用认证（本机开发）默认不限。
 */
import type { PipelineDocSummary } from '@apploom/shared';
import type { Principal } from './api-keys';

export function canAccess(doc: { ownerId?: string }, principal: Principal | undefined): boolean {
  if (!principal) return true;
  return !doc.ownerId || doc.ownerId === principal.name;
}

export interface QuotaConfig {
  maxActive: number;
  maxPerDay: number;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

export function quotaConfig(authEnabled: boolean, env: NodeJS.ProcessEnv = process.env): QuotaConfig {
  return {
    maxActive: num(env.OWNER_MAX_ACTIVE_RUNS, authEnabled ? 3 : 0),
    maxPerDay: num(env.OWNER_MAX_RUNS_PER_DAY, authEnabled ? 30 : 0),
  };
}

/** 返回 null = 允许创建；否则是拒绝原因。summaries 是该用户可见的全部流水线摘要 */
export function checkQuota(summaries: Pick<PipelineDocSummary, 'ownerId' | 'status' | 'createdAt'>[], ownerId: string, cfg: QuotaConfig, now = Date.now()): string | null {
  const mine = summaries.filter((s) => s.ownerId === ownerId);
  if (cfg.maxActive > 0) {
    const active = mine.filter((s) => s.status === 'running' || s.status === 'created').length;
    if (active >= cfg.maxActive) return `同时运行的流水线已达上限（${cfg.maxActive}），请等待现有任务结束`;
  }
  if (cfg.maxPerDay > 0) {
    const since = now - 24 * 3600_000;
    const today = mine.filter((s) => Date.parse(s.createdAt) >= since).length;
    if (today >= cfg.maxPerDay) return `24 小时内新建流水线已达上限（${cfg.maxPerDay}）`;
  }
  return null;
}
