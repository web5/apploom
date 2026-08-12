import { z } from 'zod';

/**
 * PRD 结构化 Schema —— 需求分析 Agent 的"输出契约"
 * 这是 AI 研发平台第一个 Agent 的产物地基，后续 Design/Codegen Agent 都消费它。
 * 字段以 docs/notes/prompt/agents/requirement-analyst.md 为准。
 */
export const PRDSchema = z.object({
  /** 产品概述（定位、目标用户、核心价值） */
  overview: z.string(),
  /** 目标用户群体 */
  targetUsers: z.array(z.string()),
  /** 功能清单，按 P0(必须)/P1(重要)/P2(增强) 分级 */
  features: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      priority: z.enum(['P0', 'P1', 'P2']),
      desc: z.string(),
    }),
  ),
  /** 用户故事 As a... I want to... so that... */
  userStories: z.array(z.string()),
  /** 页面清单 */
  pages: z.array(z.string()),
  /** 数据实体（最小可用，不含类型细节，细节留给 Design Agent） */
  entities: z.array(
    z.object({
      name: z.string(),
      fields: z.array(z.string()),
    }),
  ),
  /** 本次由 AI 补充的合理假设，必须显式标注 */
  assumptions: z.array(z.string()),
});

export type PRD = z.infer<typeof PRDSchema>;

/**
 * 给 LLM 的 JSON Schema（用于 response_format=json_schema / json_object）。
 * OpenAI 兼容接口的 json_schema 不支持 zod 的复杂类型，这里手写一份等价的。
 */
export const PRD_JSON_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string', description: '产品概述（定位、目标用户、核心价值）' },
    targetUsers: { type: 'array', items: { type: 'string' } },
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          desc: { type: 'string' },
        },
        required: ['id', 'name', 'priority', 'desc'],
        additionalProperties: false,
      },
    },
    userStories: { type: 'array', items: { type: 'string' } },
    pages: { type: 'array', items: { type: 'string' } },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          fields: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'fields'],
        additionalProperties: false,
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['overview', 'targetUsers', 'features', 'userStories', 'pages', 'entities', 'assumptions'],
  additionalProperties: false,
} as const;
