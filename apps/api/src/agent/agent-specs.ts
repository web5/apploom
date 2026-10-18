/**
 * 五个阶段的 Agent 声明。差别只在：schema、prompt、上游怎么渲染进 user prompt、产出怎么摘要。
 * 温度取自 STAGE_GRAPH，不在这里写。
 */
import {
  ARCHITECT_SYSTEM_PROMPT,
  CODEGEN_JSON_SCHEMA,
  CODEGEN_SYSTEM_PROMPT,
  CodegenSchema,
  DEPLOYER_SYSTEM_PROMPT,
  DEPLOY_JSON_SCHEMA,
  DESIGN_JSON_SCHEMA,
  DeploySchema,
  DesignSchema,
  PRDSchema,
  PRD_JSON_SCHEMA,
  PROTOTYPE_JSON_SCHEMA,
  PROTOTYPE_SYSTEM_PROMPT,
  PrototypeSchema,
  REQUIREMENT_ANALYST_SYSTEM_PROMPT,
  type CodegenDocument,
  type DeployDocument,
  type DesignDocument,
  type PRD,
  type PrototypeDocument,
} from '@apploom/shared';
import { prototypeForDesign, trimPrototypeForCodegen } from '../prd/prototype-digest';
import { INPUT, edgeBudget, type StageId } from '@apploom/shared';
import type { AgentSpec } from './agent-runner';

export interface PrdSummary { features: number; p0: number; assumptions: number; entities: number; warnings: string[] }
export interface PrototypeSummary { pages: number; flows: number; htmlSize: number; warnings: string[] }
export interface DesignSummary { techStack: string[]; pages: number; entities: number; apis: number; warnings: string[] }
export interface CodegenSummary { files: number; dependencies: number; notes: number; warnings: string[] }
export interface DeploySummary { target: string; url: string; status: string; warnings: string[] }

const json = (v: unknown) => JSON.stringify(v, null, 2);

export const REQUIREMENT_SPEC: AgentSpec<PRD, PrdSummary> = {
  stage: 'requirement',
  label: 'generatePrd',
  system: REQUIREMENT_ANALYST_SYSTEM_PROMPT,
  schema: PRDSchema,
  jsonSchema: PRD_JSON_SCHEMA,
  jsonSchemaName: 'PRD',
  buildUser: (i) => `用户需求：\n${i[INPUT]}`,
  summarize: (prd) => {
    const p0 = prd.features.filter((f) => f.priority === 'P0').length;
    const warnings: string[] = [];
    if (p0 > 5) warnings.push(`P0 功能 ${p0} 个，超过 MVP 上限 5`);
    if (prd.assumptions.length === 0) warnings.push('assumptions 为空，模型可能没标注假设');
    return { features: prd.features.length, p0, assumptions: prd.assumptions.length, entities: prd.entities.length, warnings };
  },
};

export const PROTOTYPE_SPEC: AgentSpec<PrototypeDocument, PrototypeSummary> = {
  stage: 'prototype',
  label: 'generatePrototype',
  system: PROTOTYPE_SYSTEM_PROMPT,
  schema: PrototypeSchema,
  jsonSchema: PROTOTYPE_JSON_SCHEMA,
  jsonSchemaName: 'PrototypeDocument',
  maxTokens: 8192,
  buildUser: (i) => `上游 PRD：\n${json(i.requirement)}`,
  summarize: (p) => {
    const warnings: string[] = [];
    if (!p.html || p.html.trim().length < 100) warnings.push('HTML 原型为空或过短');
    if (p.pages.length === 0) warnings.push('页面清单为空');
    if (p.pages.length > 8) warnings.push(`页面 ${p.pages.length} 个，可能超出 MVP 范围`);
    if (p.flows.length === 0) warnings.push('核心用户流程为空');
    return { pages: p.pages.length, flows: p.flows.length, htmlSize: p.html.length, warnings };
  },
  // HTML 字符串里最容易出现非法的反斜杠转义，让整份 JSON 作废：解析失败时带着错误让模型重新生成一次
  reask: {
    wrapError: (parseError) => `JSON 解析失败（原始错误：${parseError}）`,
    feedback: (msg) =>
      `上次输出无法解析为合法 JSON（错误：${msg.slice(0, 200)}）。请重点注意：html 字符串里所有反斜杠都必须双重转义（\\\\），不要出现 \\! \\@ \\. \\( 等非法转义；如果 HTML 里需要换行，用真正的换行符或 \\n，不要写裸反斜杠。请重新输出完整 JSON。`,
    maxTokens: 8192,
  },
};

export const DESIGN_SPEC: AgentSpec<DesignDocument, DesignSummary> = {
  stage: 'design',
  label: 'generateDesign',
  system: ARCHITECT_SYSTEM_PROMPT,
  schema: DesignSchema,
  jsonSchema: DESIGN_JSON_SCHEMA,
  jsonSchemaName: 'DesignDocument',
  buildUser: (i) =>
    `上游 PRD：\n${json(i.requirement)}\n\n上游产品原型（页面清单与交互，pageTree 请与之对齐；已省略 HTML 实现）：\n${json(prototypeForDesign(i.prototype))}`,
  summarize: (design) => {
    const warnings: string[] = [];
    if (design.pageTree.length > 8) warnings.push(`页面 ${design.pageTree.length} 个，超过 MVP 上限 8`);
    if (design.apis.length > 15) warnings.push(`API ${design.apis.length} 个，超过 MVP 上限 15`);
    if (design.dataModels.length > 6) warnings.push(`数据实体 ${design.dataModels.length} 个，超过 MVP 上限 6`);
    return { techStack: design.techStack, pages: design.pageTree.length, entities: design.dataModels.length, apis: design.apis.length, warnings };
  },
};

export const CODEGEN_SPEC: AgentSpec<CodegenDocument, CodegenSummary> = {
  stage: 'codegen',
  label: 'generateCodegen',
  system: CODEGEN_SYSTEM_PROMPT,
  schema: CodegenSchema,
  jsonSchema: CODEGEN_JSON_SCHEMA,
  jsonSchemaName: 'CodegenDocument',
  maxTokens: 8192,
  buildUser: (i) =>
    `上游 DesignDocument：\n${json(i.design)}\n\n上游产品原型精简版（页面布局与交互，UI 代码请与之对齐）：\n${trimPrototypeForCodegen(i.prototype, edgeBudget('codegen', 'prototype')).text}`,
  summarize: (codegen) => {
    const warnings: string[] = [];
    if (codegen.files.length === 0) warnings.push('文件列表为空');
    if (codegen.files.length > 30) warnings.push(`文件 ${codegen.files.length} 个，可能超出单次生成上限`);
    if (codegen.dependencies.length === 0) warnings.push('依赖列表为空');
    return { files: codegen.files.length, dependencies: codegen.dependencies.length, notes: codegen.notes.length, warnings };
  },
};

export const DEPLOY_SPEC: AgentSpec<DeployDocument, DeploySummary> = {
  stage: 'deploy',
  label: 'generateDeploy',
  system: DEPLOYER_SYSTEM_PROMPT,
  schema: DeploySchema,
  jsonSchema: DEPLOY_JSON_SCHEMA,
  jsonSchemaName: 'DeployDocument',
  maxTokens: 4096,
  buildUser: (i) => `上游 CodegenDocument：\n${json(i.codegen)}`,
  summarize: (deploy) => {
    const warnings: string[] = [];
    if (deploy.status === 'failed') warnings.push('部署状态为 failed，请检查构建日志');
    if (deploy.target === 'cloud' && !deploy.url) warnings.push('云托管目标但 URL 为空');
    if (deploy.target === 'git' && !deploy.repoUrl) warnings.push('Git 导出目标但仓库链接为空');
    return { target: deploy.target, url: deploy.url, status: deploy.status, warnings };
  },
};

/** 阶段 → 声明。图里加了阶段，这里必须有对应的声明（由测试保证） */
export const AGENT_SPECS: Record<StageId, AgentSpec<unknown, { warnings: string[] }>> = {
  requirement: REQUIREMENT_SPEC,
  prototype: PROTOTYPE_SPEC,
  design: DESIGN_SPEC,
  codegen: CODEGEN_SPEC,
  deploy: DEPLOY_SPEC,
};
