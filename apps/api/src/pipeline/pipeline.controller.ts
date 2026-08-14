/**
 * Pipeline API —— W7 异步流水线端点
 *
 *   POST /pipeline              { requirement, confirmEachStep? } → 201 { id }
 *   GET  /pipeline/:id          当前状态快照（PipelineDoc）
 *   GET  /pipeline/:id/events   SSE 实时进度流
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
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PIPELINE_STAGES, PipelineStage } from './pipeline.types';
import { PipelineService } from './pipeline.service';

@Controller('pipeline')
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

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
          payload = { stage: event.stage, status: event.status, summary: event.summary, result: event.result };
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
      res.status(404).json({ message: 'pipeline 不存在' });
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
