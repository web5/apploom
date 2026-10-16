import { CODEGEN_JSON_SCHEMA, DEPLOY_JSON_SCHEMA, DESIGN_JSON_SCHEMA, PRD_JSON_SCHEMA, PROTOTYPE_JSON_SCHEMA, DeploySchema, toLlmJsonSchema } from '@apploom/shared';
import { z } from 'zod';

const SCHEMAS = { PRD: PRD_JSON_SCHEMA, Prototype: PROTOTYPE_JSON_SCHEMA, Design: DESIGN_JSON_SCHEMA, Codegen: CODEGEN_JSON_SCHEMA, Deploy: DEPLOY_JSON_SCHEMA };

describe('给模型的 JSON Schema 由 Zod 生成（Zod 是唯一事实源）', () => {
  // 快照：Zod 字段 / 约束 / 说明任何改动都会让它变化，改动者必须在评审里确认这是预期的契约变更
  it.each(Object.entries(SCHEMAS))('%s 契约快照', (_name, schema) => {
    expect(schema).toMatchSnapshot();
  });

  /** 递归收集所有 object 节点 */
  const objects = (node: unknown, path = '$'): Array<[string, Record<string, unknown>]> => {
    if (!node || typeof node !== 'object') return [];
    const n = node as Record<string, unknown>;
    const here: Array<[string, Record<string, unknown>]> = n.type === 'object' ? [[path, n]] : [];
    const kids: Array<[string, unknown]> = [
      ...Object.entries((n.properties as Record<string, unknown>) ?? {}).map(([k, v]) => [`${path}.${k}`, v] as [string, unknown]),
      [`${path}[]`, n.items],
    ];
    return [...here, ...kids.flatMap(([p, v]) => objects(v, p))];
  };

  it('每一层对象都禁止额外字段，且 required 覆盖所有非可选字段（严格模式的前提）', () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      for (const [path, obj] of objects(schema)) {
        expect([name, path, obj.additionalProperties]).toEqual([name, path, false]);
        const props = Object.keys(obj.properties as object);
        const required = (obj.required as string[] | undefined) ?? [];
        const optional = props.filter((p) => !required.includes(p));
        // 目前唯一允许缺省的字段是 deploy.port
        expect([name, path, optional]).toEqual([name, path, name === 'Deploy' && path === '$' ? ['port'] : []]);
      }
    }
  });

  it('不带 $schema / definitions，也没有 $ref（给模型的 schema 必须自包含）', () => {
    for (const schema of Object.values(SCHEMAS)) {
      const text = JSON.stringify(schema);
      expect(text).not.toMatch(/\$schema|\$ref|definitions/);
    }
  });

  it('.describe() 的文字原样进入生成结果（模型看得到字段说明）', () => {
    expect((DEPLOY_JSON_SCHEMA.properties as Record<string, { description: string }>).port.description).toContain('部署前会检查占用并 kill');
    expect((PRD_JSON_SCHEMA.properties as Record<string, { description: string }>).overview.description).toBe('产品概述（定位、目标用户、核心价值）');
  });

  it('Zod 的约束会体现在生成结果里（port 为 1024–65535 的整数），且 Zod 与 schema 对同一非法值一致拒绝', () => {
    const port = (DEPLOY_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>).port;
    expect(port).toMatchObject({ type: 'integer', minimum: 1024, maximum: 65535 });
    expect(DeploySchema.safeParse({ target: 'local', url: '', repoUrl: '', buildLog: '', status: 'success', port: 80 }).success).toBe(false);
  });

  it('toLlmJsonSchema 可用于任意 Zod（新增阶段只要写一份 Zod）', () => {
    expect(toLlmJsonSchema(z.object({ a: z.string().describe('说明'), b: z.number().optional() }))).toEqual({
      type: 'object',
      properties: { a: { type: 'string', description: '说明' }, b: { type: 'number' } },
      required: ['a'],
      additionalProperties: false,
    });
  });
});
