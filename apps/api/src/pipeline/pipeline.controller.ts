/**
 * Pipeline API —— W7 异步流水线端点
 *
 *   POST /pipeline              { requirement, confirmEachStep? } → 201 { id }
 *   GET  /pipeline/:id          当前状态快照（PipelineDoc）
 *   GET  /pipeline/:id/events   SSE 实时进度流
 *   GET  /pipeline/:id/trace    阶段执行记录列表（?stage=）；/trace/:attemptId 取完整记录
 *   GET  /pipeline/:id/approvals 待人工审批项；POST /approvals/:aid { decision: approve|reject }
 *   POST /pipeline/:id/confirm  { stage } 逐步确认，放行下一阶段
 *   POST /pipeline/:id/retry    { stage? } 重试失败阶段
 *
 * SSE 事件流：
 *   event: snapshot  —— 连接时立即推送当前 doc
 *   event: stage     —— 阶段状态变化 { stage, status, summary? }
 *   event: token     —— LLM 流式 token { stage, token }
 *   event: job       —— 流水线整体状态 { status }
 *   event: done           —— 全部完成 { doc }
 *   event: pipeline-error —— 阶段失败 { stage, message }
 *   （业务错误不用 event: error，避免与 EventSource 原生连接错误事件冲突）
 */
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PIPELINE_STAGES, PipelineStage } from './pipeline.types';
import { PipelineService } from './pipeline.service';
import { ApprovalService } from '../approval/approval.service';
import { pipelineTokenBudget, sumUsage, totalTokens } from '../trace/budget';

@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly approvals: ApprovalService,
  ) {}

  /** 历史项目列表（摘要，按更新时间倒序） */
  @Get()
  async list(@Res() res: Response) {
    const items = await this.pipeline.list();
    res.json({ items });
  }

  /** 创建异步任务：立即返回 jobId，后台 Worker 开始执行 */
  @Post()
  async create(
    @Body() body: { requirement?: string; confirmEachStep?: boolean },
    @Res() res: Response,
  ) {
    const requirement = (body?.requirement ?? '').trim();
    if (!requirement) {
      res.status(400).json({ message: 'requirement 不能为空' });
      return;
    }
    const id = await this.pipeline.create(requirement, body?.confirmEachStep !== false);
    res.status(201).json({ id });
  }

  /** 状态快照：轮询兜底（正常用 SSE 看进度） */
  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const doc = await this.pipeline.get(id);
    if (!doc) {
      res.status(404).json({ message: 'pipeline 不存在' });
      return;
    }
    res.json(doc);
  }

  /** 执行记录列表（不含 prompt/响应体）；?stage= 过滤阶段 */
  @Get(':id/trace')
  async trace(@Param('id') id: string, @Query('stage') stage: string | undefined, @Res() res: Response) {
    if (stage && !PIPELINE_STAGES.includes(stage as PipelineStage)) {
      res.status(400).json({ message: `stage 无效，可选: ${PIPELINE_STAGES.join(' | ')}` });
      return;
    }
    if (!(await this.pipeline.get(id))) {
      res.status(404).json({ message: 'pipeline 不存在' });
      return;
    }
    // usage / budget 始终按整条流水线统计（不受 ?stage= 过滤影响），与预算熔断口径一致
    const all = await this.pipeline.listAttempts(id);
    const usage = sumUsage(all);
    const items = stage ? all.filter((a) => a.stage === stage) : all;
    res.json({ items, usage: { ...usage, totalTokens: totalTokens(usage) }, budget: pipelineTokenBudget() });
  }

  /** 单次执行的完整记录（含每次 LLM 调用的 prompt / 响应 / 用量，可用于复盘重放） */
  @Get(':id/trace/:attemptId')
  async attempt(@Param('id') id: string, @Param('attemptId') attemptId: string, @Res() res: Response) {
    const record = await this.pipeline.getAttempt(id, attemptId);
    if (!record) {
      res.status(404).json({ message: '执行记录不存在' });
      return;
    }
    res.json(record);
  }

  /** 当前等待人工审批的高风险操作 */
  @Get(':id/approvals')
  listApprovals(@Param('id') id: string, @Res() res: Response) {
    res.json({ items: this.approvals.list(id) });
  }

  /** 人工决策：{ decision: 'approve' | 'reject' }；已处理或已超时返回 404 */
  @Post(':id/approvals/:approvalId')
  decideApproval(
    @Param('id') id: string,
    @Param('approvalId') approvalId: string,
    @Body() body: { decision?: string },
    @Res() res: Response,
  ) {
    if (body?.decision !== 'approve' && body?.decision !== 'reject') {
      res.status(400).json({ message: "decision 必须是 'approve' 或 'reject'" });
      return;
    }
    if (!this.approvals.decide(id, approvalId, body.decision)) {
      res.status(404).json({ message: '审批项不存在、已处理或已超时' });
      return;
    }
    res.json({ ok: true });
  }

  /** SSE 实时进度流 */
  @Get(':id/events')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  async events(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    // 必须显式 flush 头，浏览器才能边收边渲染
    res.flushHeaders?.();

    const doc = await this.pipeline.get(id);
    if (!doc) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'pipeline 不存在' })}\n\n`);
      return res.end();
    }
    // 连接时先推当前快照，避免错过已发生的状态（与 emitSnapshot 统一为 { doc } 形态）
    res.write(`event: snapshot\ndata: ${JSON.stringify({ doc })}\n\n`);

    const unsubscribe = this.pipeline.subscribe(id, (event) => {
      let eventName = 'message';
      let payload: unknown = event;
      switch (event.type) {
        case 'stage':
          eventName = 'stage';
          payload = { stage: event.stage, status: event.status, summary: event.summary, result: event.result, error: event.error, errorClass: event.errorClass };
          break;
        case 'token':
          eventName = 'token';
          payload = { stage: event.stage, token: event.token };
          break;
        case 'job':
          eventName = 'job';
          payload = { status: event.status };
          break;
        case 'done':
          eventName = 'done';
          payload = { doc: event.doc };
          break;
        case 'error':
          eventName = 'pipeline-error';
          payload = { stage: event.stage, message: event.message };
          break;
        case 'snapshot':
          eventName = 'snapshot';
          payload = { doc: event.doc };
          break;
        case 'approval':
          eventName = 'approval';
          payload = { approval: event.approval };
          break;
        case 'approval-resolved':
          eventName = 'approval-resolved';
          payload = { id: event.id, decision: event.decision };
          break;
      }
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    // 心跳：防止代理/浏览器把空闲连接掐断
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

    req.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    });
  }

  /** 逐步确认：确认当前等待的阶段，放行下一阶段 */
  @Post(':id/confirm')
  async confirm(
    @Param('id') id: string,
    @Body() body: { stage?: string },
    @Res() res: Response,
  ) {
    const stage = body?.stage as PipelineStage | undefined;
    if (!stage || !PIPELINE_STAGES.includes(stage)) {
      res.status(400).json({ message: `stage 无效，可选: ${PIPELINE_STAGES.join(' | ')}` });
      return;
    }
    const ok = await this.pipeline.confirm(id, stage);
    if (!ok) {
      // 区分「不存在」与「状态不允许」：连点确认时第二次是后者（已确认过），不应报成找不到
      if (await this.pipeline.get(id)) {
        res.status(409).json({ message: `阶段「${stage}」当前不在待确认状态（可能已被确认）` });
      } else {
        res.status(404).json({ message: 'pipeline 不存在' });
      }
      return;
    }
    res.json({ ok: true });
  }

  /** 失败重试：不传 stage 则自动重试失败的那个 */
  @Post(':id/retry')
  async retry(
    @Param('id') id: string,
    @Body() body: { stage?: string },
    @Res() res: Response,
  ) {
    const stage = body?.stage as PipelineStage | undefined;
    const ok = await this.pipeline.retry(id, stage);
    if (!ok) {
      res.status(400).json({ message: '任务不存在或不在可重试状态（需 status = failed）' });
      return;
    }
    res.json({ ok: true });
  }

  /** AI 修复/修改：带反馈重新生成某阶段（feedback 省略则自动用 error） */
  @Post(':id/repair')
  async repair(
    @Param('id') id: string,
    @Body() body: { stage?: string; feedback?: string },
    @Res() res: Response,
  ) {
    const stage = body?.stage as PipelineStage | undefined;
    if (!stage || !PIPELINE_STAGES.includes(stage)) {
      res.status(400).json({ message: `stage 无效，可选: ${PIPELINE_STAGES.join(' | ')}` });
      return;
    }
    const ok = await this.pipeline.repair(id, stage, body?.feedback);
    if (!ok) {
      res.status(400).json({ message: '任务不存在或阶段缺少可修复的 feedback/error' });
      return;
    }
    res.json({ ok: true });
  }
}
