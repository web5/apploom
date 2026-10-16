import { z } from 'zod';
import { toLlmJsonSchema } from '../json-schema';

/**
 * CodegenOutput 结构化 Schema —— 代码生成 Agent 的"输出契约"
 * 上游：DesignDocument（架构设计 Agent）；下游：部署发布 Agent
 * 字段以 docs/notes/prompt/agents/codegen.md 为准。
 */
export const CodegenSchema = z.object({
  /** 生成的文件集合 */
  files: z.array(
    z.object({
      path: z.string().describe('文件路径，如 src/App.tsx'),
      content: z.string().describe('完整文件内容'),
    }),
  ),
  /** 运行所需依赖清单（包名@版本，如 react@^18；不含 shell 命令/操作符） */
  dependencies: z.array(
    z.string().regex(/^[a-zA-Z0-9@._\/\-^~*]+$/, '依赖必须是合法 npm 包名（如 react@^18、@prisma/client），不能含命令/操作符/空格'),
  ).describe('运行所需依赖清单（包名@版本，如 react@^18、@prisma/client；命令放 runCommand，不要放 && / 空格等）'),
  /** 本地启动命令 */
  runCommand: z.string().describe('本地启动命令，如 npm run dev'),
  /** 需要用户注意的点 */
  notes: z.array(z.string()).describe('需要用户注意的点'),
});

export type CodegenDocument = z.infer<typeof CodegenSchema>;

/** 给 LLM 的 JSON Schema（response_format 用）：由上面的 Zod 生成，不要手写 */
export const CODEGEN_JSON_SCHEMA = toLlmJsonSchema(CodegenSchema);
