/**
 * PipelineModule —— W7 异步流水线
 *
 * 依赖 PrdModule 的 LlmService（4 个 Agent 的 LLM 调用都在里面）。
 * PrdModule 已 export LlmService，这里直接注入。
 */
import { Module } from '@nestjs/common';
import { PrdModule } from '../prd/prd.module';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';
import { PipelineStore } from './pipeline.store';
import { PipelineBus } from './pipeline.bus';

@Module({
  imports: [PrdModule],
  controllers: [PipelineController],
  providers: [PipelineService, PipelineStore, PipelineBus],
})
export class PipelineModule {}
