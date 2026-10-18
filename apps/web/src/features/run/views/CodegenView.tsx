import { useState } from 'react';
import type { CodegenDocument } from '@apploom/shared';

export function CodegenView({ codegen }: { codegen: CodegenDocument }) {
  const [selectedFile, setSelectedFile] = useState<number | null>(0);
  return (
    <div>
      <section><h4>文件 ({codegen.files.length})</h4>
        <div className="file-tree">
          {codegen.files.map((f, i) => (
            <div key={i} className="file-item" onClick={() => setSelectedFile(i)}>
              {selectedFile === i ? '▸' : '▹'} {f.path}
            </div>
          ))}
        </div>
      </section>
      {selectedFile !== null && codegen.files[selectedFile] && (
        <section>
          <h4>{codegen.files[selectedFile].path}</h4>
          <div className="code-block">{codegen.files[selectedFile].content}</div>
        </section>
      )}
      <section><h4>依赖 ({codegen.dependencies.length})</h4>
        <div className="tags">{codegen.dependencies.map((d) => <span key={d} className="tag" style={{ background: '#fef3c7', color: '#92400e' }}>{d}</span>)}</div>
      </section>
      <section><h4>启动命令</h4><code style={{ fontSize: 12 }}>{codegen.runCommand}</code></section>
      {codegen.notes.length > 0 && (
        <section><h4>注意事项</h4><ul>{codegen.notes.map((n, i) => <li key={i} style={{ color: '#92400e' }}>{n}</li>)}</ul></section>
      )}
    </div>
  );
}
