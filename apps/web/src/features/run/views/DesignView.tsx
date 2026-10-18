import type { DesignDocument } from '@apploom/shared';

export function DesignView({ design }: { design: DesignDocument }) {
  return (
    <div>
      <section><h4>技术栈</h4><div className="tags">{design.techStack.map((t) => <span key={t} className="tag" style={{ background: '#eff6ff', color: '#3b82f6' }}>{t}</span>)}</div></section>
      <section><h4>架构说明</h4><p>{design.architecture}</p></section>
      <section><h4>页面树 ({design.pageTree.length})</h4>
        <ul>{design.pageTree.map((p) => <li key={p.path}><code>{p.path}</code> → {p.component}（{p.description}）</li>)}</ul>
      </section>
      <section><h4>数据模型 ({design.dataModels.length})</h4>
        <ul>{design.dataModels.map((e) => <li key={e.name}><b>{e.name}</b>: {e.fields.map((f) => `${f.name}:${f.type}`).join(', ')}</li>)}</ul>
      </section>
      <section><h4>API ({design.apis.length})</h4>
        <table className="ft">
          <thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead>
          <tbody>{design.apis.map((a, i) => <tr key={i}><td>{a.method}</td><td><code>{a.path}</code></td><td>{a.description}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}
