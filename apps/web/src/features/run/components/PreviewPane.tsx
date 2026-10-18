import type { CodegenDocument, DeployDocument, DesignDocument, PRD, PrototypeDocument } from '@apploom/shared';
import { CodegenView, DeployView, DesignView, PrdView, PrototypeView } from '../views';

/** 右侧产出预览：流式输出中显示原始文本，否则显示最后一个已产出阶段的结构化视图 */
export function PreviewPane({
  showStream, streaming, previewLabel, deploy, codegen, design, prototype, prd,
}: {
  showStream: boolean;
  streaming: string;
  previewLabel: string;
  deploy?: DeployDocument;
  codegen?: CodegenDocument;
  design?: DesignDocument;
  prototype?: PrototypeDocument;
  prd?: PRD;
}) {
  return (
    <aside className="preview">
      <header className="pv-header">
        <span>产出预览</span>
        <span className="pv-sub">
          {showStream ? (
            <span className="studio-pv-streaming">
              <span className="studio-dot-pulse" />
              生成中 · {streaming.length} 字符
            </span>
          ) : previewLabel}
        </span>
      </header>
      <div className="pv-body">
        {showStream ? (
          <div>
            <div className="raw-banner">
              <span className="banner-spin" />
              <span>生成中 · 已接收 {streaming.length} 字符</span>
            </div>
            <pre className="raw">
              {streaming || '等待模型响应…'}
              <span className="studio-cursor-blink">▋</span>
            </pre>
          </div>
        ) : deploy ? (
          <DeployView deploy={deploy} />
        ) : codegen ? (
          <CodegenView codegen={codegen} />
        ) : design ? (
          <DesignView design={design} />
        ) : prototype ? (
          <PrototypeView prototype={prototype} />
        ) : prd ? (
          <PrdView prd={prd} />
        ) : (
          <p className="ph">输入一句话需求，依次经过 5 个 Agent：需求拆解 → 产品原型 → 方案设计 → 代码生成 → 部署发布。</p>
        )}
      </div>
    </aside>
  );
}
