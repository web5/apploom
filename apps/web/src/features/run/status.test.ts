import { describe, expect, it } from 'vitest';
import { pipelineBadge, pipelineStatusLabel, statusIcon, statusLabel, toStatus } from './status';

describe('status 映射', () => {
  it('后端阶段状态 → 前端状态，包括 stale；未知 / 缺省按待执行', () => {
    expect(toStatus('running')).toBe('running');
    expect(toStatus('done')).toBe('done');
    expect(toStatus('failed')).toBe('error');
    expect(toStatus('waiting_confirm')).toBe('waiting_confirm');
    expect(toStatus('stale')).toBe('stale');
    expect(toStatus('pending')).toBe('pending');
    expect(toStatus(undefined)).toBe('pending');
  });

  it('每种前端状态都有标签与图标；stale 显示「已过期」与回环图标，待执行显示序号', () => {
    for (const s of ['pending', 'running', 'done', 'error', 'waiting_confirm', 'stale'] as const) {
      expect(statusLabel(s)).toBeTruthy();
      expect(statusIcon(s, 3)).toBeTruthy();
    }
    expect(statusLabel('stale')).toBe('已过期');
    expect(statusIcon('stale', 3)).toBe('↻');
    expect(statusIcon('pending', 3)).toBe(3);
  });

  it('流水线整体状态的标签与徽标类', () => {
    expect(pipelineStatusLabel('completed')).toBe('已完成');
    expect(pipelineBadge('failed')).toBe('error');
    expect(pipelineBadge('created')).toBe('pending');
  });
});
