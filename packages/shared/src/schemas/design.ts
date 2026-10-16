import { z } from 'zod';
import { toLlmJsonSchema } from '../json-schema';

/**
 * DesignDocument 结构化 Schema —— 架构设计 Agent 的"输出契约"
 * 上游：PRD（需求分析 Agent 产出）；下游：代码生成 Agent
 * 字段以 docs/notes/prompt/agents/architect.md 为准。
 */
export const DesignSchema = z.object({
  /** 技术选型（由本 Agent 决策，不预设） */
  techStack: z.array(z.string()).describe('技术选型（由 Agent 按场景决策）'),
  /** 整体架构说明 */
  architecture: z.string().describe('整体架构说明'),
  /** 页面结构树 + 路由 */
  pageTree: z.array(
    z.object({
      path: z.string(),
      component: z.string(),
      description: z.string(),
    }),
  ),
  /** 数据模型（ER） */
  dataModels: z.array(
    z.object({
      name: z.string(),
      fields: z.array(z.object({ name: z.string(), type: z.string() })),
    }),
  ),
  /** API 接口清单 */
  apis: z.array(
    z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string(),
      description: z.string(),
    }),
  ),
});

export type DesignDocument = z.infer<typeof DesignSchema>;

/** 给 LLM 的 JSON Schema（response_format 用）：由上面的 Zod 生成，不要手写 */
export const DESIGN_JSON_SCHEMA = toLlmJsonSchema(DesignSchema);
