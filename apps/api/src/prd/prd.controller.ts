import { Controller, Post, Body, Res, Header } from '@nestjs/common';
import type { Response } from 'express';
import { LlmService } from './llm.service';

/**
 * Agent 调试接口（SSE 流式）
 *   POST /prd/generate  { requirement: string }   需求分析 Agent
 *   POST /prd/design    { prd: PRD 对象 }          架构设计 Agent
 *   POST /prd/codegen   { design: Design 对象 }    代码生成 Agent
 *   POST /prd/deploy    { codegen: Codegen 对象 }  部署发布 Agent
 *   事件流：
 *     event: token   data: "..."   —— 逐 token 流式输出
 *     event: done     data: { prd/design/codegen/deploy, summary, ... }
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

  /** 代码生成 Agent：上游 DesignDocument → 多文件代码 */
  @Post('codegen')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  async codegen(@Body() body: { design?: unknown }, @Res() res: Response) {
    if (!body?.design) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'design 不能为空' })}\n\n`);
      return res.end();
    }
    res.flushHeaders?.();
    try {
      const result = await this.llm.generateCodegen(body.design, (token) => {
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

  /** 部署发布 Agent：上游 CodegenDocument → 部署方案 */
  @Post('deploy')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  async deploy(@Body() body: { codegen?: unknown }, @Res() res: Response) {
    if (!body?.codegen) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'codegen 不能为空' })}\n\n`);
      return res.end();
    }
    res.flushHeaders?.();
    try {
      const result = await this.llm.generateDeploy(body.codegen, (token) => {
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
