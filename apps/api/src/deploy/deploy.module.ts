/**
 * DeployModule —— 本地真部署服务（W7+1 MVP）
 *
 * 现阶段只导出 LocalDeployService：真实写盘 + install + 启动 dev server。
 * 未来 cloud/git 目标实现后再加 DeployAgentService（LLM 描述）。
 */
import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { LocalDeployService } from './local-deploy.service';

@Module({
  imports: [ApprovalModule],
  providers: [LocalDeployService],
  exports: [LocalDeployService],
})
export class DeployModule {}