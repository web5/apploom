/**
 * 路由里带 :id 的请求先核对归属：无权访问按「不存在」处理（404）。不带 :id 的路由（列表 / 创建）直接放行，由控制器按用户过滤。
 */
import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { PipelineService } from '../pipeline/pipeline.service';
import type { Principal } from './api-keys';
import { canAccess } from './ownership';

@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(private readonly pipeline: PipelineService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ params?: Record<string, string>; principal?: Principal }>();
    const id = req.params?.id;
    if (!id || !req.principal) return true;
    const doc = await this.pipeline.get(id);
    if (doc && !canAccess(doc, req.principal)) throw new NotFoundException('pipeline 不存在');
    return true; // 不存在的 id 交给各路由原有的 404 逻辑
  }
}
