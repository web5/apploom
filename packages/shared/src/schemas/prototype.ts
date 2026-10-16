import { z } from 'zod';

/**
 * PrototypeDocument 结构化 Schema —— 产品原型 Agent 的"输出契约"
 * 上游：PRD（需求分析 Agent 产出）；下游：方案设计 / 代码生成 Agent
 *
 * 定位：需求拆解完成后，产出「可预览的 HTML 原型交互稿」，帮助确认最终 UI 布局与交互流程，
 * 再进入技术方案设计与代码实现。核心是单文件 HTML（内嵌 CSS/JS，页面间可切换交互），前端 iframe 预览。
 */
export const PrototypeSchema = z.object({
  /** 应用名 */
  appName: z.string(),
  /** 整体设计风格一句话（如：简约卡片式 / 顶部导航 + 内容区） */
  designStyle: z.string(),
  /** 完整可预览的单文件 HTML（内嵌 CSS/JS，页面间可切换，不引用外部资源） */
  html: z.string(),
  /** 页面清单（前端展示导航用，与 html 内的页面一一对应） */
  pages: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
    }),
  ),
  /** 核心用户流程说明（如：创建任务 → 指派 → 完成） */
  flows: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    }),
  ),
});

export type PrototypeDocument = z.infer<typeof PrototypeSchema>;

/** 给 LLM 的 JSON Schema（response_format 用） */
export const PROTOTYPE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    appName: { type: 'string', description: '应用名' },
    designStyle: { type: 'string', description: '整体设计风格一句话' },
    html: { type: 'string', description: '完整可预览的单文件 HTML（内嵌 CSS/JS，页面间可切换，不引用外部资源）' },
    pages: {
      type: 'array',
      description: '页面清单（与 html 内的页面一一对应）',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '页面唯一标识，如 home' },
          title: { type: 'string', description: '页面标题' },
        },
        required: ['id', 'title'],
        additionalProperties: false,
      },
    },
    flows: {
      type: 'array',
      description: '核心用户流程说明',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '流程名' },
          description: { type: 'string', description: '流程说明' },
        },
        required: ['name', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['appName', 'designStyle', 'html', 'pages', 'flows'],
  additionalProperties: false,
} as const;
