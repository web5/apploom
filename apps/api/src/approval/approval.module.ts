/**
 * ApprovalModule —— 人工审批（HITL）
 *
 * PipelineBus 必须全局唯一（worker、SSE、审批共用同一个进程内事件桥），
 * 因此由本模块提供并导出，PipelineModule / DeployModule 都从这里取，不再各自声明。
 */
import { Module } from '@nestjs/common';
import { PipelineBus } from '../pipeline/pipeline.bus';
import { ApprovalService } from './approval.service';

@Module({
  providers: [PipelineBus, ApprovalService],
  exports: [PipelineBus, ApprovalService],
})
export class ApprovalModule {}
