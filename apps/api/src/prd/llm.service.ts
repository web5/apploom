import { Injectable } from '@nestjs/common';
import { loadProviderFromEnv, chat, type LlmLogEntry } from '@apploom/llm';
import { prototypeForDesign, renderPrototypeForCodegen } from './prototype-digest';
import {
  PRDSchema,
  PRD_JSON_SCHEMA,
  REQUIREMENT_ANALYST_SYSTEM_PROMPT,
  PrototypeSchema,
  PROTOTYPE_JSON_SCHEMA,
  PROTOTYPE_SYSTEM_PROMPT,
  DesignSchema,
  DESIGN_JSON_SCHEMA,
  ARCHITECT_SYSTEM_PROMPT,
  CodegenSchema,
  type CodegenDocument,
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

/**
 * 修复 LLM 输出里常见的「非法反斜杠转义」导致的 JSON 解析失败。
 * 根因：模型在 HTML 字符串里写出了 `\!` `\.` `\(` 等非法转义（JSON 合法转义只有
 * `\" \\ \/ \b \f \n \r \t \uXXXX`）。把「反斜杠 + 非合法转义字符」修正为「双反斜杠 + 原字符」，
 * 既保留合法转义，又修复非法转义。修复的是模型自己生成的 HTML，修复后仍是 LLM 产出。
 * 注意：用负向后顾 (?<!\\) 避免把合法 `\\` 转义的第二根反斜杠也误修。
 */
function tryRepairJson(raw: string): string | null {
  let json: string;
  try {
    json = extractJson(raw);
    JSON.parse(json); // 本就能解析 → 无需修复
    return null;
  } catch {
    json = extractJson(raw);
  }
  // 关键正则：匹配「前面不是反斜杠、且后面跟一个非法转义字符」的反斜杠，把该 \ 转义为 \\
  const fixed = json.replace(/(?<!\\)\\(?!["\\/bfnrtu])/g, '\\\\');
  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    return null;
  }
}

/** 安全解析为 PrototypeDocument（Zod 校验），失败返回 null */
function parsePrototype(raw: string): unknown | null {
  try {
    return PrototypeSchema.parse(JSON.parse(extractJson(raw)));
  } catch {
    return null;
  }
}

/** 统一构造 PrototypeResult（含默认校验 warning） */
function buildPrototypeResult(raw: string, prototype: unknown, extraWarnings: string[]): PrototypeResult {
  const p = prototype as { html: string; pages: { id: string; title: string }[]; flows: { name: string; description: string }[] };
  const warnings = [...extraWarnings];
  if (!p.html || p.html.trim().length < 100) warnings.push('HTML 原型为空或过短');
  if (p.pages.length === 0) warnings.push('页面清单为空');
  if (p.pages.length > 8) warnings.push(`页面 ${p.pages.length} 个，可能超出 MVP 范围`);
  if (p.flows.length === 0) warnings.push('核心用户流程为空');
  return {
    raw,
    prototype,
    summary: {
      pages: p.pages.length,
      flows: p.flows.length,
      htmlSize: p.html.length,
      warnings,
    },
  };
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
/** 带反馈重生成上下文：用户修复意见 + 上次产出/错误 */
export interface RepairContext {
  feedback: string;
  previous?: unknown;
  previousError?: string;
}

/** 拼装带反馈的 user 提示词 */
function buildRepairSuffix(repair: RepairContext): string {
  let s = `\n\n# 修改要求（重要）\n请根据以下反馈，修正你上一次的产出并重新输出完整结果：\n反馈：${repair.feedback}`;
  if (repair.previous !== undefined) {
    s += `\n\n上次产出（供参考，请在此基础上修正）：\n${JSON.stringify(repair.previous, null, 2)}`;
  }
  if (repair.previousError) {
    s += `\n\n上次失败原因：\n${repair.previousError}`;
  }
  return s;
}

@Injectable()
export class LlmService {
  async generatePrd(
    requirement: string,
    onToken: (token: string) => void,
    repair?: RepairContext,
    onLog?: (entry: LlmLogEntry) => void,
  ): Promise<PrdResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      label: 'generatePrd',
      onLog,
      system: REQUIREMENT_ANALYST_SYSTEM_PROMPT,
      user: `用户需求：\n${requirement}${repair ? buildRepairSuffix(repair) : ''}`,
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
   * 产品原型 Agent：上游 PRD → 产品交互原型线框稿（PrototypeDocument）
   * 定位：需求拆解完成后，产出可确认的 UI 布局与交互流程，再进入技术方案设计。
   */
  async generatePrototype(
    prd: unknown,
    onToken: (token: string) => void,
    repair?: RepairContext,
    onLog?: (entry: LlmLogEntry) => void,
  ): Promise<PrototypeResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      label: 'generatePrototype',
      onLog,
      system: PROTOTYPE_SYSTEM_PROMPT,
      user: `上游 PRD：\n${JSON.stringify(prd, null, 2)}${repair ? buildRepairSuffix(repair) : ''}`,
      temperature: 0.6,
      maxTokens: 8192,
      jsonSchema: { name: 'PrototypeDocument', schema: PROTOTYPE_JSON_SCHEMA as unknown as Record<string, unknown> },
      stream: true,
      onToken,
    });

    const raw = result.content;
    // 1) 直接解析
    let parseError = '';
    const direct = parsePrototype(raw);
    if (direct) return buildPrototypeResult(raw, direct, []);
    try {
      PrototypeSchema.parse(JSON.parse(extractJson(raw)));
    } catch (e) {
      parseError = (e as Error).message;
    }
    // 2) 本地修复非法反斜杠转义后重试解析（修复的仍是模型自己生成的 HTML）
    const repaired = tryRepairJson(raw);
    if (repaired) {
      const reparsed = parsePrototype(repaired);
      if (reparsed) {
        console.warn('[generatePrototype] 通过本地 JSON 修复（反斜杠非法转义）恢复原型成功');
        return buildPrototypeResult(repaired, reparsed, ['已通过本地 JSON 修复恢复（原始输出含反斜杠非法转义，已自动修正）']);
      }
    }
    // 3) 仍失败 → 让 LLM 重新生成（带错误反馈），最多一次
    const msg = `JSON 解析失败（原始错误：${parseError}）`;
    if (!repair) {
      console.warn(`[generatePrototype] JSON 解析失败，让 LLM 重新生成 1 次：${msg}`);
      const retryResult = await this.generatePrototypeWithRepair(prd, onToken, {
        feedback: `上次输出无法解析为合法 JSON（错误：${msg.slice(0, 200)}）。请重点注意：html 字符串里所有反斜杠都必须双重转义（\\\\），不要出现 \\! \\@ \\. \\( 等非法转义；如果 HTML 里需要换行，用真正的换行符或 \\n，不要写裸反斜杠。请重新输出完整 JSON。`,
        previous: raw,
        previousError: msg,
      }, onLog);
      if (!retryResult.error) return retryResult;
      // 重试还失败，返回带详细错误的结果
      return { raw, error: `JSON 解析失败（重试后仍失败）：${msg}` };
    }
    const truncationHint = detectTruncation(raw, msg);
    return { raw, error: truncationHint ?? msg };
  }

  /** 自动重试专用：复用 generatePrototype 但强制带 repair 上下文 */
  private async generatePrototypeWithRepair(
    prd: unknown,
    onToken: (token: string) => void,
    repair: RepairContext,
    onLog?: (entry: LlmLogEntry) => void,
  ): Promise<PrototypeResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      label: 'generatePrototype-retry',
      onLog,
      system: PROTOTYPE_SYSTEM_PROMPT,
      user: `上游 PRD：\n${JSON.stringify(prd, null, 2)}${buildRepairSuffix(repair)}`,
      temperature: 0.6,
      maxTokens: 8192,
      jsonSchema: { name: 'PrototypeDocument', schema: PROTOTYPE_JSON_SCHEMA as unknown as Record<string, unknown> },
      stream: true,
      onToken,
    });
    const raw = result.content;
    const direct = parsePrototype(raw);
    if (direct) return buildPrototypeResult(raw, direct, ['已通过 LLM 重新生成成功（上次 JSON 解析失败）']);
    // LLM 重生成也可能再次带非法转义，先用本地修复兜底一次
    const repaired = tryRepairJson(raw);
    if (repaired) {
      const reparsed = parsePrototype(repaired);
      if (reparsed) return buildPrototypeResult(repaired, reparsed, ['已通过 LLM 重新生成 + 本地 JSON 修复恢复']);
    }
    return { raw, error: `JSON 解析失败（LLM 重新生成后仍无法解析）` };
  }

  /**
   * 架构设计 Agent：上游 PRD + 原型 → 技术方案 DesignDocument
   * 本 Agent 是技术栈的决策者（全局基座不预设栈，由它按场景选）。
   * 参考原型稿的页面清单，让 pageTree 与原型 screens 对齐。
   */
  async generateDesign(
    prd: unknown,
    prototype: unknown,
    onToken: (token: string) => void,
    repair?: RepairContext,
    onLog?: (entry: LlmLogEntry) => void,
  ): Promise<DesignResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      label: 'generateDesign',
      onLog,
      system: ARCHITECT_SYSTEM_PROMPT,
      user: `上游 PRD：\n${JSON.stringify(prd, null, 2)}\n\n上游产品原型（页面清单与交互，pageTree 请与之对齐；已省略 HTML 实现）：\n${JSON.stringify(prototypeForDesign(prototype), null, 2)}${repair ? buildRepairSuffix(repair) : ''}`,
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
   * 代码生成 Agent：上游 DesignDocument + 产品原型 → 多文件代码
   * 绑定的是用户产品技术栈（来自上游 techStack），不是平台技术栈。
   * 参考原型稿的布局与交互，生成符合原型的 UI 代码。
   * maxTokens 设为 8192（DeepSeek 上限），避免代码量大时被截断导致 JSON 不完整。
   */
  async generateCodegen(
    design: unknown,
    prototype: unknown,
    onToken: (token: string) => void,
    repair?: RepairContext,
    onLog?: (entry: LlmLogEntry) => void,
  ): Promise<CodegenResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      label: 'generateCodegen',
      onLog,
      system: CODEGEN_SYSTEM_PROMPT,
      user: `上游 DesignDocument：\n${JSON.stringify(design, null, 2)}\n\n上游产品原型精简版（页面布局与交互，UI 代码请与之对齐）：\n${renderPrototypeForCodegen(prototype)}${repair ? buildRepairSuffix(repair) : ''}`,
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
   * 部署发布 Agent：上游 CodegenDocument → 部署方案（决策 target）
   * 产出 DeployDocument，后端根据 target 分发 executor 落地（local 真执行）。
   */
  async generateDeploy(
    codegen: unknown,
    onToken: (token: string) => void,
    repair?: RepairContext,
    onLog?: (entry: LlmLogEntry) => void,
  ): Promise<DeployResult> {
    const provider = loadProviderFromEnv();
    const result = await chat(provider, {
      label: 'generateDeploy',
      onLog,
      system: DEPLOYER_SYSTEM_PROMPT,
      user: `上游 CodegenDocument：\n${JSON.stringify(codegen, null, 2)}${repair ? buildRepairSuffix(repair) : ''}`,
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

export interface PrototypeResult {
  raw: string;
  prototype?: unknown;
  error?: string;
  summary?: {
    pages: number;
    flows: number;
    htmlSize: number;
    warnings: string[];
  };
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
  codegen?: CodegenDocument;
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
