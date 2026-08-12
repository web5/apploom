#!/usr/bin/env tsx
/**
 * 提示词调试闭环入口：几句话需求 → 结构化 PRD
 *
 * 用法：
 *   pnpm --filter @aidp/llm debug:prd "做一个团队待办事项应用"
 *   pnpm --filter @aidp/llm debug:prd ./req.txt        # 从文件读需求
 *   echo "做一个番茄钟" | pnpm --filter @aidp/llm debug:prd   # 从 stdin
 *
 * 环境变量：LLM_PROVIDER(deepseek|hunyuan) + 对应 API key
 *   DEEPSEEK_API_KEY=xxx 或 HUNYUAN_API_KEY=xxx
 */
import { readFileSync } from 'node:fs';
import { PRDSchema, PRD_JSON_SCHEMA, REQUIREMENT_ANALYST_SYSTEM_PROMPT } from '@aidp/shared';
import { loadProviderFromEnv } from './providers';
import { chat } from './gateway';

/** 从模型输出里抽取 JSON（兼容 markdown 代码块 / 前后多余文字） */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

async function readRequirement(): Promise<string> {
  const arg = process.argv[2];
  if (arg) {
    if (arg.endsWith('.txt') || arg.endsWith('.md')) {
      return readFileSync(arg, 'utf-8').trim();
    }
    return arg.trim();
  }
  // stdin
  try {
    return readFileSync(0, 'utf-8').trim();
  } catch {
    return '';
  }
}

async function main() {
  const requirement = await readRequirement();
  if (!requirement) {
    console.error('未读到需求。用法：debug:prd "一句话需求" 或 管道输入。');
    process.exit(1);
  }

  const provider = loadProviderFromEnv();
  console.error(`[调试] provider=${provider.model} @ ${provider.baseURL}`);
  console.error(`[调试] 需求：${requirement}\n`);

  const result = await chat(provider, {
    system: REQUIREMENT_ANALYST_SYSTEM_PROMPT,
    user: `用户需求：\n${requirement}`,
    temperature: 0.7,
    jsonSchema: { name: 'PRD', schema: PRD_JSON_SCHEMA as unknown as Record<string, unknown> },
    stream: true,
    onToken: (t) => process.stdout.write(t),
  });

  // 二次校验（网关用 json_object，模型可能不严格遵守，用 Zod 兜底）
  let prd;
  try {
    prd = PRDSchema.parse(JSON.parse(extractJson(result.content)));
  } catch (e) {
    console.error('\n\n[校验失败] 模型输出不符合 PRD Schema：');
    console.error((e as Error).message);
    console.error('原始输出：\n' + result.content);
    process.exit(2);
  }

  const p0 = prd.features.filter((f) => f.priority === 'P0').length;
  console.error('\n\n=== 校验通过 PRD ===');
  console.log(JSON.stringify(prd, null, 2));
  console.error(`\n[调试摘要] 功能共 ${prd.features.length} 个（P0=${p0}） | 假设 ${prd.assumptions.length} 条 | 实体 ${prd.entities.length} 个`);
  if (p0 > 5) console.error('[提示词警告] P0 超过 5 个，违反 MVP 优先约束，建议收紧 Prompt。');
  if (prd.assumptions.length === 0) console.error('[提示词警告] assumptions 为空，模型可能没标注假设。');
}

main().catch((e) => {
  console.error('运行出错：', (e as Error).message);
  process.exit(1);
});
