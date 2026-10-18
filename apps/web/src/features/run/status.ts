import type { PipelineStatus, StageStatus } from '@apploom/shared';

/** 前端展示用的阶段状态（后端 StageStatus 的归并） */
export type Status = 'pending' | 'running' | 'done' | 'error' | 'waiting_confirm';

/** 后端 StageStatus → 前端 Status（stale 暂按待执行展示，专门的过期样式留待后续） */
export function toStatus(s?: StageStatus): Status {
  switch (s) {
    case 'running': return 'running';
    case 'done': return 'done';
    case 'failed': return 'error';
    case 'waiting_confirm': return 'waiting_confirm';
    default: return 'pending';
  }
}

export function statusLabel(s: Status) {
  return { pending: '待执行', running: '生成中', done: '已完成', error: '失败', waiting_confirm: '待确认' }[s];
}

/** 任务整体状态 → 中文标签 */
export function pipelineStatusLabel(s: PipelineStatus) {
  return { created: '待执行', running: '进行中', waiting_confirm: '待确认', failed: '失败', completed: '已完成' }[s];
}

/** 任务整体状态 → 前端 badge 样式类 */
export function pipelineBadge(s: PipelineStatus): Status {
  return ({ created: 'pending', running: 'running', waiting_confirm: 'waiting_confirm', failed: 'error', completed: 'done' } as Record<PipelineStatus, Status>)[s];
}

export function statusIcon(s: Status, num: number) {
  if (s === 'done') return '✓';
  if (s === 'running') return '◐';
  if (s === 'error') return '✕';
  if (s === 'waiting_confirm') return '⏸';
  return num;
}
