import { z } from 'zod';

/**
 * DeployDocument 结构化 Schema —— 部署发布 Agent 的"输出契约"
 * 上游：CodegenDocument（代码生成 Agent）；下游：无（末环）
 * 字段以 docs/notes/prompt/agents/deploy.md 为准。
 */
export const DeploySchema = z.object({
  /** 部署目标：本地真部署 | 内置云托管 | Git 仓库导出 */
  target: z.enum(['local', 'cloud', 'git']),
  /** 可访问的线上地址（云托管时） */
  url: z.string(),
  /** Git 仓库链接（导出时，无则为空串） */
  repoUrl: z.string(),
  /** 构建日志摘要 */
  buildLog: z.string(),
  /** 部署状态 */
  status: z.enum(['success', 'failed']),
  /** 期望启动的本地端口（local 目标时，部署前会检查占用并 kill） */
  port: z.number().int().min(1024).max(65535).optional(),
});

export type DeployDocument = z.infer<typeof DeploySchema>;

/** 给 LLM 的 JSON Schema（response_format 用） */
export const DEPLOY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', enum: ['local', 'cloud', 'git'], description: '部署目标' },
    url: { type: 'string', description: '可访问的线上地址（云托管 / 本地时）' },
    repoUrl: { type: 'string', description: 'Git 仓库链接（导出时，无则为空串）' },
    buildLog: { type: 'string', description: '构建日志摘要' },
    status: { type: 'string', enum: ['success', 'failed'], description: '部署状态' },
    port: { type: 'number', description: '期望启动的本地端口（local 目标时，如 vite 5173 / next 3000；部署前会检查占用并 kill）' },
  },
  required: ['target', 'url', 'repoUrl', 'buildLog', 'status'],
  additionalProperties: false,
} as const;
