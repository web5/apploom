import { Controller, Post, Body, Res, Header } from '@nestjs/common';
import type { Response } from 'express';
import { LlmService } from './llm.service';

/**
 * Agent 调试接口（SSE 流式）
 *   POST /prd/generate  { requirement: string }   需求分析 Agent
 *   POST /prd/design    { prd: PRD 对象 }          架构设计 Agent
 *   事件流：
 *     event: token   data: "..."   —— 逐 token 流式输出
 *     event: done     data: { prd/design, summary, ... }
 *     event: error    data: { message }
 */
@Controller('prd')
export class PrdController {
  constructor(private readonly llm: LlmService) {}

  @Post('generate')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  async generate(@Body() body: { requirement?: string }, @Res() res: Response) {
    const requirement = (body?.requirement ?? '').trim();
    if (!requirement) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'requirement 不能为空' })}\n\n`);
      return res.end();
    }
    // 必须显式 flush 头，浏览器才能边收边渲染
    res.flushHeaders?.();
    try {
      const result = await this.llm.generatePrd(requirement, (token) => {
        res.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
      });
      res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (e) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
      );
    } finally {
      res.end();
    }
  }

  /** 架构设计 Agent：上游 PRD → 技术方案 DesignDocument */
  @Post('design')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  async design(@Body() body: { prd?: unknown }, @Res() res: Response) {
    if (!body?.prd) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'prd 不能为空' })}\n\n`);
      return res.end();
    }
    res.flushHeaders?.();
    try {
      const result = await this.llm.generateDesign(body.prd, (token) => {
        res.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
      });
      res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (e) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
      );
    } finally {
      res.end();
    }
  }
}
