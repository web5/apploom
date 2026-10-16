import { z } from 'zod';
import { toLlmJsonSchema } from '../json-schema';

/**
 * PRD 结构化 Schema —— 需求分析 Agent 的"输出契约"
 * 这是 AI 研发平台第一个 Agent 的产物地基，后续 Design/Codegen Agent 都消费它。
 * 字段以 docs/notes/prompt/agents/requirement-analyst.md 为准。
 */
export const PRDSchema = z.object({
  /** 产品概述（定位、目标用户、核心价值） */
  overview: z.string().describe('产品概述（定位、目标用户、核心价值）'),
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

/** 给 LLM 的 JSON Schema（response_format 用）：由上面的 Zod 生成，不要手写 */
export const PRD_JSON_SCHEMA = toLlmJsonSchema(PRDSchema);
