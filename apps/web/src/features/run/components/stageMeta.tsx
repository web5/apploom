import type { CodegenDocument, DeployDocument, DesignDocument, PRD, PrototypeDocument } from '@apploom/shared';
import type { StageId } from '@apploom/shared/graph';

/** 各阶段卡片摘要行（数据来自后端 doc.stages[stage].result） */
export function stageMeta(stage: StageId, prd?: PRD, prototype?: PrototypeDocument, design?: DesignDocument, codegen?: CodegenDocument, deploy?: DeployDocument) {
  if (stage === 'requirement' && prd) {
    return (
      <div className="stage-body">
        <div className="meta-row">
          <span>功能 {prd.features.length}</span>
          <span>P0 {prd.features.filter((f) => f.priority === 'P0').length}</span>
          <span>假设 {prd.assumptions.length}</span>
          <span>实体 {prd.entities.length}</span>
        </div>
      </div>
    );
  }
  if (stage === 'prototype' && prototype) {
    return (
      <div className="stage-body">
        <div className="meta-row">
          <span>页面 {prototype.pages.length}</span>
          <span>流程 {prototype.flows.length}</span>
          <span>HTML {Math.round(prototype.html.length / 1024)}KB</span>
        </div>
      </div>
    );
  }
  if (stage === 'design' && design) {
    return (
      <div className="stage-body">
        <div className="techstack">
          {design.techStack.map((t) => <span key={t} className="tk">{t}</span>)}
        </div>
        <div className="meta-row">
          <span>页面 {design.pageTree.length}</span>
          <span>实体 {design.dataModels.length}</span>
          <span>API {design.apis.length}</span>
        </div>
      </div>
    );
  }
  if (stage === 'codegen' && codegen) {
    return (
      <div className="stage-body">
        <div className="meta-row">
          <span>文件 {codegen.files.length}</span>
          <span>依赖 {codegen.dependencies.length}</span>
          <span>注意 {codegen.notes.length}</span>
        </div>
      </div>
    );
  }
  if (stage === 'deploy' && deploy) {
    return (
      <div className="stage-body">
        <div className="meta-row">
          <span>目标 {deploy.target === 'local' ? '本地' : deploy.target === 'cloud' ? '云托管' : 'Git 导出'}</span>
          <span className={deploy.status === 'success' ? 'ok' : 'fail'}>
            {deploy.status === 'success' ? '✓ 成功' : '✗ 失败'}
          </span>
          {deploy.url && <a className="deploy-url" href={deploy.url} target="_blank" rel="noopener noreferrer">{deploy.url}</a>}
        </div>
      </div>
    );
  }
  return null;
}
