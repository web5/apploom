import { buildPreviewHtml, PREVIEW_SANDBOX } from '@/components/studio/previewHtml';
import type { PrototypeDocument } from '@apploom/shared';

export function PrototypeView({ prototype }: { prototype: PrototypeDocument }) {
  return (
    <div>
      <section>
        <h4>应用</h4>
        <p><b>{prototype.appName}</b> · {prototype.designStyle}</p>
      </section>
      <section>
        <h4>页面 ({prototype.pages.length})</h4>
        <div className="tags">
          {prototype.pages.map((p) => <span key={p.id} className="tag">{p.title}</span>)}
        </div>
      </section>
      <section>
        <h4>交互预览</h4>
        <iframe
          className="proto-frame"
          srcDoc={buildPreviewHtml(prototype.html)}
          title="产品原型预览"
          sandbox={PREVIEW_SANDBOX}
        />
      </section>
      <section>
        <h4>核心流程 ({prototype.flows.length})</h4>
        {prototype.flows.map((f) => (
          <div key={f.name} className="flow-item">
            <b>{f.name}</b><span className="flow-desc">{f.description}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
