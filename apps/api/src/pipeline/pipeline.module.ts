/**
 * PipelineModule —— W7 异步流水线
 *
 * 依赖 PrdModule 的 LlmService（4 个 Agent 的 LLM 调用都在里面）。
 * 依赖 DeployModule 的 LocalDeployService（deploy 阶段真实写盘 + 启动 dev server）。
 * PrdModule 已 export LlmService，这里直接注入。
 */
import { Module } from '@nestjs/common';
import { PrdModule } from '../prd/prd.module';
import { DeployModule } from '../deploy/deploy.module';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';
import { PipelineStore } from './pipeline.store';
import { ApprovalModule } from '../approval/approval.module';
import { CodegenGateService } from '../gate/codegen-gate';
import { TraceStore } from '../trace/trace.store';

@Module({
  imports: [PrdModule, DeployModule, ApprovalModule],
  controllers: [PipelineController],
  // PipelineBus 由 ApprovalModule 提供并导出（全局唯一）
  providers: [PipelineService, PipelineStore, CodegenGateService, TraceStore],
})
export class PipelineModule {}
