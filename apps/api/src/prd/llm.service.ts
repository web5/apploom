import { Injectable } from '@nestjs/common';
import { loadProviderFromEnv, chat } from '@apploom/llm';
import {
  PRDSchema,
  PRD_JSON_SCHEMA,
  REQUIREMENT_ANALYST_SYSTEM_PROMPT,
  DesignSchema,
  DESIGN_JSON_SCHEMA,
  ARCHITECT_SYSTEM_PROMPT,
  CodegenSchema,
  CODEGEN_JSON_SCHEMA,
  CODEGEN_SYSTEM_PROMPT,
  DeploySchema,
  DEPLOY_JSON_SCHEMA,
  DEPLOYER_SYSTEM_PROMPT,
} from '@apploom/shared';

/** 从模型输出里抽取 JSON（兼容 markdown 代码块 / 前后多余文字） */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

/** 检测 JSON 是否被截断（max_tokens 不足时常见） */
function detectTruncation(raw: string, parsedError: string): string | null {
  // JSON.parse 报 "Unterminated string" 或 "Unexpected end of JSON input" 通常是截断
  if (/Unterminated string|Unexpected end of JSON|Unexpected token/.test(parsedError)) {
    const tail = raw.slice(-200);
    return `LLM 输出疑似被 max_tokens 截断（raw 长度 ${raw.length} 字符）。错误：${parsedError}。尾部 200 字符：${JSON.stringify(tail)}`;
  }
  return null;
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

  /**
   * 架构设计 Agent：上游 PRD → 技术方案 DesignDocument
   * 本 Agent 是技术栈的决策者（全局基座不预设栈，由它按场景选）。
   */
  async generateDesign(
    prd: unknown,
    onToken: (token: string) => void,
  ): Promise<DesignResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      system: ARCHITECT_SYSTEM_PROMPT,
      user: `上游 PRD：\n${JSON.stringify(prd, null, 2)}`,
      temperature: 0.5,
      jsonSchema: { name: 'DesignDocument', schema: DESIGN_JSON_SCHEMA as unknown as Record<string, unknown> },
      stream: true,
      onToken,
    });

    const raw = result.content;
    try {
      const design = DesignSchema.parse(JSON.parse(extractJson(raw)));
      const warnings: string[] = [];
      if (design.pageTree.length > 8) warnings.push(`页面 ${design.pageTree.length} 个，超过 MVP 上限 8`);
      if (design.apis.length > 15) warnings.push(`API ${design.apis.length} 个，超过 MVP 上限 15`);
      if (design.dataModels.length > 6) warnings.push(`数据实体 ${design.dataModels.length} 个，超过 MVP 上限 6`);
      return {
        raw,
        design,
        summary: {
          techStack: design.techStack,
          pages: design.pageTree.length,
          entities: design.dataModels.length,
          apis: design.apis.length,
          warnings,
        },
      };
    } catch (e) {
      return { raw, error: (e as Error).message };
    }
  }

  /**
   * 代码生成 Agent：上游 DesignDocument → 多文件代码
   * 绑定的是用户产品技术栈（来自上游 techStack），不是平台技术栈。
   * maxTokens 设为 8192（DeepSeek 上限），避免代码量大时被截断导致 JSON 不完整。
   */
  async generateCodegen(
    design: unknown,
    onToken: (token: string) => void,
  ): Promise<CodegenResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      system: CODEGEN_SYSTEM_PROMPT,
      user: `上游 DesignDocument：\n${JSON.stringify(design, null, 2)}`,
      temperature: 0.3,
      maxTokens: 8192,
      jsonSchema: { name: 'CodegenDocument', schema: CODEGEN_JSON_SCHEMA as unknown as Record<string, unknown> },
      stream: true,
      onToken,
    });

    const raw = result.content;
    try {
      const codegen = CodegenSchema.parse(JSON.parse(extractJson(raw)));
      const warnings: string[] = [];
      if (codegen.files.length === 0) warnings.push('文件列表为空');
      if (codegen.files.length > 30) warnings.push(`文件 ${codegen.files.length} 个，可能超出单次生成上限`);
      if (codegen.dependencies.length === 0) warnings.push('依赖列表为空');
      return {
        raw,
        codegen,
        summary: {
          files: codegen.files.length,
          dependencies: codegen.dependencies.length,
          notes: codegen.notes.length,
          warnings,
        },
      };
    } catch (e) {
      const msg = (e as Error).message;
      const truncationHint = detectTruncation(raw, msg);
      return { raw, error: truncationHint ?? msg };
    }
  }

  /**
   * 部署发布 Agent：上游 CodegenDocument → 部署方案
   * 产出部署 URL / Git 仓库链接 + 构建日志，非真正执行部署。
   */
  async generateDeploy(
    codegen: unknown,
    onToken: (token: string) => void,
  ): Promise<DeployResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      system: DEPLOYER_SYSTEM_PROMPT,
      user: `上游 CodegenDocument：\n${JSON.stringify(codegen, null, 2)}`,
      temperature: 0.3,
      maxTokens: 4096,
      jsonSchema: { name: 'DeployDocument', schema: DEPLOY_JSON_SCHEMA as unknown as Record<string, unknown> },
      stream: true,
      onToken,
    });

    const raw = result.content;
    try {
      const deploy = DeploySchema.parse(JSON.parse(extractJson(raw)));
      const warnings: string[] = [];
      if (deploy.status === 'failed') warnings.push('部署状态为 failed，请检查构建日志');
      if (deploy.target === 'cloud' && !deploy.url) warnings.push('云托管目标但 URL 为空');
      if (deploy.target === 'git' && !deploy.repoUrl) warnings.push('Git 导出目标但仓库链接为空');
      return {
        raw,
        deploy,
        summary: {
          target: deploy.target,
          url: deploy.url,
          status: deploy.status,
          warnings,
        },
      };
    } catch (e) {
      const msg = (e as Error).message;
      const truncationHint = detectTruncation(raw, msg);
      return { raw, error: truncationHint ?? msg };
    }
  }
}

export interface DesignResult {
  raw: string;
  design?: unknown;
  error?: string;
  summary?: {
    techStack: string[];
    pages: number;
    entities: number;
    apis: number;
    warnings: string[];
  };
}

export interface CodegenResult {
  raw: string;
  codegen?: unknown;
  error?: string;
  summary?: {
    files: number;
    dependencies: number;
    notes: number;
    warnings: string[];
  };
}

export interface DeployResult {
  raw: string;
  deploy?: unknown;
  error?: string;
  summary?: {
    target: string;
    url: string;
    status: string;
    warnings: string[];
  };
}
