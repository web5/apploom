import type { PRD } from '@apploom/shared';

export function PrdView({ prd }: { prd: PRD }) {
  const PC = { P0: '#ef4444', P1: '#f59e0b', P2: '#8b5cf6' };
  return (
    <div>
      <section><h4>概述</h4><p>{prd.overview}</p></section>
      <section><h4>目标用户</h4><div className="tags">{prd.targetUsers.map((u) => <span key={u} className="tag">{u}</span>)}</div></section>
      <section><h4>功能 ({prd.features.length})</h4>
        <table className="ft">
          <thead><tr><th>ID</th><th>功能</th><th>优先级</th><th>说明</th></tr></thead>
          <tbody>
            {prd.features.map((f) => (
              <tr key={f.id}><td>{f.id}</td><td>{f.name}</td>
                <td><span className="prio" style={{ color: PC[f.priority], borderColor: PC[f.priority] }}>{f.priority}</span></td>
                <td>{f.desc}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section><h4>页面</h4><div className="tags">{prd.pages.map((p) => <span key={p} className="tag">{p}</span>)}</div></section>
      <section><h4>实体</h4><ul>{prd.entities.map((e) => <li key={e.name}><b>{e.name}</b>: {e.fields.join(', ')}</li>)}</ul></section>
      <section><h4>假设</h4><ul>{prd.assumptions.map((a, i) => <li key={i} style={{ color: '#92400e' }}>{a}</li>)}</ul></section>
    </div>
  );
}
