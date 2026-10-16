/**
 * LlmService：五个阶段 Agent 的入口。真正的「调模型 → 解析 → 容错」在 agent/agent-runner.ts，
 * 各阶段的差异（schema / prompt / 摘要）在 agent/agent-specs.ts；这里只负责把结果映射成各阶段原有的返回形状。
 */
import { Injectable } from '@nestjs/common';
import type { ErrorClass, LlmLogEntry } from '@apploom/llm';
import type { CodegenDocument, DeployDocument, DesignDocument, PRD, PrototypeDocument } from '@apploom/shared';
import { runAgent, type AgentCtx, type AgentResult, type ChatFn } from '../agent/agent-runner';
import {
  CODEGEN_SPEC,
  DEPLOY_SPEC,
  DESIGN_SPEC,
  PROTOTYPE_SPEC,
  REQUIREMENT_SPEC,
  type CodegenSummary,
  type DeploySummary,
  type DesignSummary,
  type PrdSummary,
  type PrototypeSummary,
} from '../agent/agent-specs';
import type { RepairContext } from '../agent/repair';

interface Failure {
  raw: string;
  error?: string;
  /** error 的类别：被 max_tokens 截断时为 'truncated'，缺省按 invalid_output 处理 */
  errorClass?: ErrorClass;
}

export type PrdResult = Failure & { prd?: PRD; summary?: PrdSummary };
export type PrototypeResult = Failure & { prototype?: PrototypeDocument; summary?: PrototypeSummary };
export type DesignResult = Failure & { design?: DesignDocument; summary?: DesignSummary };
export type CodegenResult = Failure & { codegen?: CodegenDocument; summary?: CodegenSummary };
export type DeployResult = Failure & { deploy?: DeployDocument; summary?: DeploySummary };

/** 把 runner 的统一结果（doc）换成各阶段原有的键名（prd / prototype / …） */
function shape<K extends string, TDoc, TSummary>(key: K, r: AgentResult<TDoc, TSummary>) {
  const { doc, ...rest } = r;
  return { ...rest, ...(doc !== undefined ? { [key]: doc } : {}) } as Failure & { summary?: TSummary } & { [P in K]?: TDoc };
}

@Injectable()
export class LlmService {
  /** 模型客户端：默认走真实网关；测试可替换为脚本化的假模型（见 agent/fake-model.ts） */
  chatFn?: ChatFn;

  private ctx(onToken: (token: string) => void, repair?: RepairContext, onLog?: (entry: LlmLogEntry) => void): AgentCtx {
    return { onToken, onLog, repair, chatFn: this.chatFn };
  }

  /** 需求分析：一句话需求 → 结构化 PRD */
  async generatePrd(requirement: string, onToken: (token: string) => void, repair?: RepairContext, onLog?: (entry: LlmLogEntry) => void): Promise<PrdResult> {
    return shape('prd', await runAgent(REQUIREMENT_SPEC, requirement, this.ctx(onToken, repair, onLog)));
  }

  /** 产品原型：上游 PRD → 可预览的单文件 HTML 原型 */
  async generatePrototype(prd: unknown, onToken: (token: string) => void, repair?: RepairContext, onLog?: (entry: LlmLogEntry) => void): Promise<PrototypeResult> {
    return shape('prototype', await runAgent(PROTOTYPE_SPEC, prd, this.ctx(onToken, repair, onLog)));
  }

  /** 架构设计：PRD + 原型 → 技术方案（技术栈由本 Agent 决策，全局基座不预设） */
  async generateDesign(prd: unknown, prototype: unknown, onToken: (token: string) => void, repair?: RepairContext, onLog?: (entry: LlmLogEntry) => void): Promise<DesignResult> {
    return shape('design', await runAgent(DESIGN_SPEC, { prd, prototype }, this.ctx(onToken, repair, onLog)));
  }

  /** 代码生成：方案 + 原型精简版 → 多文件代码 */
  async generateCodegen(design: unknown, prototype: unknown, onToken: (token: string) => void, repair?: RepairContext, onLog?: (entry: LlmLogEntry) => void): Promise<CodegenResult> {
    return shape('codegen', await runAgent(CODEGEN_SPEC, { design, prototype }, this.ctx(onToken, repair, onLog)));
  }

  /** 部署发布：代码 → 部署方案（决策 target，真正执行由 deploy 模块负责） */
  async generateDeploy(codegen: unknown, onToken: (token: string) => void, repair?: RepairContext, onLog?: (entry: LlmLogEntry) => void): Promise<DeployResult> {
    return shape('deploy', await runAgent(DEPLOY_SPEC, codegen, this.ctx(onToken, repair, onLog)));
  }
}
