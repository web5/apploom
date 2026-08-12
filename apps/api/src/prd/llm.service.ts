import { Injectable } from '@nestjs/common';
import { loadProviderFromEnv, chat } from '@aidp/llm';
import {
  PRDSchema,
  PRD_JSON_SCHEMA,
  REQUIREMENT_ANALYST_SYSTEM_PROMPT,
} from '@aidp/shared';

/** 从模型输出里抽取 JSON（兼容 markdown 代码块 / 前后多余文字） */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

export interface PrdResult {
  raw: string;
  prd?: unknown;
  error?: string;
  summary?: {
    features: number;
    p0: number;
    assumptions: number;
    entities: number;
    warnings: string[];
  };
}

/**
 * 需求分析 Agent 服务：几句话需求 → 结构化 PRD（带流式回调 + Zod 校验）
 * 这是 W3 的核心，但作为提示词调试闭环的最小功能先跑通。
 */
@Injectable()
export class LlmService {
  async generatePrd(
    requirement: string,
    onToken: (token: string) => void,
  ): Promise<PrdResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      system: REQUIREMENT_ANALYST_SYSTEM_PROMPT,
      user: `用户需求：\n${requirement}`,
      temperature: 0.7,
      jsonSchema: { name: 'PRD', schema: PRD_JSON_SCHEMA as unknown as Record<string, unknown> },
      stream: true,
      onToken,
    });

    const raw = result.content;
    try {
      const prd = PRDSchema.parse(JSON.parse(extractJson(raw)));
      const p0 = prd.features.filter((f) => f.priority === 'P0').length;
      const warnings: string[] = [];
      if (p0 > 5) warnings.push(`P0 功能 ${p0} 个，超过 MVP 上限 5`);
      if (prd.assumptions.length === 0) warnings.push('assumptions 为空，模型可能没标注假设');
      return {
        raw,
        prd,
        summary: {
          features: prd.features.length,
          p0,
          assumptions: prd.assumptions.length,
          entities: prd.entities.length,
          warnings,
        },
      };
    } catch (e) {
      return { raw, error: (e as Error).message };
    }
  }
}
