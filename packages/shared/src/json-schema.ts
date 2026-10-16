/**
 * 给模型的 JSON Schema（response_format 用）由 Zod 生成，Zod 是唯一事实源——
 * 不要再手写一份等价的：双份维护必然漂移。字段说明请写在 Zod 的 .describe() 里，会原样进入生成结果。
 */
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export function toLlmJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  // zodToJsonSchema 对泛型 ZodTypeAny 会触发 TS2589（类型展开过深），这里用收窄的签名调用
  const generate = zodToJsonSchema as unknown as (s: unknown, o: { target: string; $refStrategy: string }) => Record<string, unknown>;
  const { $schema: _omit, ...rest } = generate(schema, { target: 'jsonSchema7', $refStrategy: 'none' });
  return rest;
}
