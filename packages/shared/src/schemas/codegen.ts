import { z } from 'zod';

/**
 * CodegenOutput 结构化 Schema —— 代码生成 Agent 的"输出契约"
 * 上游：DesignDocument（架构设计 Agent）；下游：部署发布 Agent
 * 字段以 docs/notes/prompt/agents/codegen.md 为准。
 */
export const CodegenSchema = z.object({
  /** 生成的文件集合 */
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
    }),
  ),
  /** 运行所需依赖清单（仅 npm 包名，不含 shell 命令/操作符） */
  dependencies: z.array(
    z.string().regex(/^[@a-zA-Z0-9][a-zA-Z0-9@._/-]*$/, '依赖必须是合法 npm 包名（如 react、@prisma/client），不能含命令/操作符'),
  ),
  /** 本地启动命令 */
  runCommand: z.string(),
  /** 需要用户注意的点 */
  notes: z.array(z.string()),
});

export type CodegenDocument = z.infer<typeof CodegenSchema>;

/** 给 LLM 的 JSON Schema（response_format 用） */
export const CODEGEN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，如 src/App.tsx' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    dependencies: {
      type: 'array',
      items: { type: 'string', pattern: '^[@a-zA-Z0-9][a-zA-Z0-9@._/-]*$' },
      description: '运行所需依赖清单（仅 npm 包名，如 react、@prisma/client；命令放 runCommand，不要放 && / 空格等）',
    },
    runCommand: { type: 'string', description: '本地启动命令，如 npm run dev' },
    notes: { type: 'array', items: { type: 'string' }, description: '需要用户注意的点' },
  },
  required: ['files', 'dependencies', 'runCommand', 'notes'],
  additionalProperties: false,
} as const;
