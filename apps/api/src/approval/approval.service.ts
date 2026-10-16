/**
 * ApprovalService —— 人工介入（HITL）：高风险操作挂起等待审批，带超时。
 *
 * 流程：request() 登记待审批项 → SSE 推 `approval` 事件 → 人通过 POST /pipeline/:id/approvals/:aid 决策
 *       → 解除挂起；超时视为「审批不可用」，操作不执行（宁可停下，不默认放行）。
 *
 * HITL_MODE：ask（默认，需要审批的操作等人）| auto（不再询问，一律放行，明显破坏性命令仍拒绝）| deny（需要审批的一律拒绝）
 * HITL_TIMEOUT_MS：审批等待上限，默认 300000（5 分钟）。注意等待期间会占用 worker，不宜过长。
 *
 * 待审批项保存在进程内存：Worker 与 API 同进程，重启后挂起的 job 本身也会被重新入队，无需持久化。
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, Approver } from '@apploom/tools';
import { PipelineBus } from '../pipeline/pipeline.bus';
import type { ApprovalView, PipelineStage } from '../pipeline/pipeline.types';
import { assessShell, type RiskLevel } from './policy';

export type HitlMode = 'ask' | 'auto' | 'deny';

export function hitlMode(): HitlMode {
  const v = (process.env.HITL_MODE ?? 'ask').toLowerCase();
  return v === 'auto' || v === 'deny' ? v : 'ask';
}

export function hitlTimeoutMs(): number {
  const n = Number(process.env.HITL_TIMEOUT_MS ?? 300_000);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

export interface ApprovalRequestInput {
  docId: string;
  stage: PipelineStage;
  tool: string;
  summary: string;
  risk: RiskLevel;
}

interface Pending {
  view: ApprovalView;
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly bus: PipelineBus) {}

  /** 申请一次审批；返回封闭集合决策（allowed-once / rejected / unavailable） */
  request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    const mode = hitlMode();
    if (mode === 'auto') return Promise.resolve('allowed-once');
    if (mode === 'deny') return Promise.resolve('rejected');

    const timeoutMs = hitlTimeoutMs();
    const id = randomUUID();
    const now = Date.now();
    const view: ApprovalView = {
      id,
      docId: input.docId,
      stage: input.stage,
      tool: input.tool,
      summary: input.summary,
      risk: input.risk,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
    };

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => this.settle(id, 'unavailable', '审批超时'), timeoutMs);
      this.pending.set(id, { view, resolve, timer });
      this.logger.warn(`等待人工审批 doc=${input.docId} [${input.risk}] ${input.summary}（${Math.round(timeoutMs / 1000)}s 内未决策将视为拒绝）`);
      this.bus.emit(input.docId, { type: 'approval', approval: view });
    });
  }

  /** 人工决策；审批项已处理或已超时返回 false */
  decide(docId: string, approvalId: string, decision: 'approve' | 'reject'): boolean {
    const p = this.pending.get(approvalId);
    if (!p || p.view.docId !== docId) return false;
    this.settle(approvalId, decision === 'approve' ? 'allowed-once' : 'rejected', decision === 'approve' ? '已批准' : '已拒绝');
    return true;
  }

  list(docId: string): ApprovalView[] {
    return [...this.pending.values()].map((p) => p.view).filter((v) => v.docId === docId);
  }

  /** 给 @apploom/tools 的 approver：先按策略判定，只有 ask 才打扰人 */
  approverFor(docId: string, stage: PipelineStage): Approver {
    return async (req) => {
      if (req.tool === 'shell') {
        const verdict = assessShell((req.input ?? {}) as { command: string; args?: string[] });
        if (verdict.action === 'deny') {
          this.logger.warn(`已拒绝 doc=${docId} ${req.summary}：${verdict.reason}`);
          return 'rejected';
        }
        if (verdict.action === 'allow') return 'allowed-once';
        return this.request({ docId, stage, tool: req.tool, summary: `${req.summary}（${verdict.reason}）`, risk: verdict.risk });
      }
      return this.request({ docId, stage, tool: req.tool, summary: req.summary, risk: 'medium' });
    };
  }

  private settle(id: string, decision: ApprovalDecision, note: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.logger.log(`审批结果 doc=${p.view.docId} ${p.view.tool}: ${decision}（${note}）`);
    this.bus.emit(p.view.docId, { type: 'approval-resolved', id, decision });
    p.resolve(decision);
  }
}
