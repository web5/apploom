'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

/* ── 类型 ── */
type Status = 'idle' | 'running' | 'done' | 'error';
type AgentKey = 'prd' | 'design' | 'codegen' | 'deploy';
type Priority = 'P0' | 'P1' | 'P2';

interface Feature { id: string; name: string; priority: Priority; desc: string; }
interface Entity { name: string; fields: string[]; }
interface PRD {
  overview: string; targetUsers: string[]; features: Feature[];
  userStories: string[]; pages: string[]; entities: Entity[]; assumptions: string[];
}
interface DesignDoc {
  techStack: string[]; architecture: string;
  pageTree: { path: string; component: string; description: string }[];
  dataModels: { name: string; fields: { name: string; type: string }[] }[];
  apis: { method: string; path: string; description: string }[];
}
interface CodegenDoc {
  files: { path: string; content: string }[];
  dependencies: string[]; runCommand: string; notes: string[];
}
interface DeployDoc {
  target: string; url: string; repoUrl: string; buildLog: string; status: string;
}

const PRIORITY_COLOR: Record<Priority, string> = {
  P0: '#ef4444', P1: '#f59e0b', P2: '#8b5cf6',
};

const AGENTS: {
  key: AgentKey; label: string; icon: string; endpoint: string;
  inputKey: string; inputLabel: string; inputPlaceholder: string;
  outputKey: string; desc: string;
}[] = [
  { key: 'prd', label: '需求分析', icon: '1', endpoint: '/api/prd/generate', inputKey: 'requirement', inputLabel: '需求描述', inputPlaceholder: '例如：做一个团队待办事项应用，支持任务指派和看板', outputKey: 'prd', desc: '一句话 → 结构化 PRD' },
  { key: 'design', label: '架构设计', icon: '2', endpoint: '/api/prd/design', inputKey: 'prd', inputLabel: 'PRD JSON', inputPlaceholder: '粘贴上游 PRD JSON，或点「带入上次 PRD」', outputKey: 'design', desc: 'PRD → 技术方案 DesignDocument' },
  { key: 'codegen', label: '代码生成', icon: '3', endpoint: '/api/prd/codegen', inputKey: 'design', inputLabel: 'Design JSON', inputPlaceholder: '粘贴上游 Design JSON，或点「带入上次 Design」', outputKey: 'codegen', desc: 'Design → 多文件代码' },
  { key: 'deploy', label: '部署发布', icon: '4', endpoint: '/api/prd/deploy', inputKey: 'codegen', inputLabel: 'Codegen JSON', inputPlaceholder: '粘贴上游 Codegen JSON，或点「带入上次 Codegen」', outputKey: 'deploy', desc: 'Codegen → 部署方案 + URL' },
];

export default function DebugPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) {
    return <div className="workspace" suppressHydrationWarning><div style={{ padding: 24, color: '#9ca3af' }}>加载中…</div></div>;
  }

  return <DebugPageInner />;
}

function DebugPageInner() {
  const [agent, setAgent] = useState<AgentKey>('prd');
  const [requirement, setRequirement] = useState('做一个团队待办事项应用，支持任务指派和看板');
  const [designInput, setDesignInput] = useState('');
  const [codegenInput, setCodegenInput] = useState('');
  const [deployInput, setDeployInput] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [raw, setRaw] = useState('');
  const [result, setResult] = useState<unknown>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  /* 各 agent 上次成功输出，供下游「带入」 */
  const lastOutput = useRef<Record<AgentKey, unknown>>({} as Record<AgentKey, unknown>);

  const inputMap: Record<AgentKey, [string, (v: string) => void]> = {
    prd: [requirement, setRequirement],
    design: [designInput, setDesignInput],
    codegen: [codegenInput, setCodegenInput],
    deploy: [deployInput, setDeployInput],
  };

  const agentCfg = AGENTS.find((a) => a.key === agent)!;
  const [inputVal, setInputVal] = inputMap[agent];

  const send = useCallback(async () => {
    if (!inputVal.trim() || status === 'running') return;
    setStatus('running');
    setRaw('');
    setResult(null);
    setSummary(null);
    setError('');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(agentCfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [agentCfg.inputKey]: agent === 'prd' ? inputVal : safeParse(inputVal) }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let rawAcc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() ?? '';
        for (const ev of events) {
          const lines = ev.split('\n');
          let evt = 'message';
          let data = '';
          for (const ln of lines) {
            if (ln.startsWith('event:')) evt = ln.slice(6).trim();
            else if (ln.startsWith('data:')) data += ln.slice(5).trim();
          }
          if (evt === 'token') {
            rawAcc += JSON.parse(data);
            setRaw(rawAcc);
          } else if (evt === 'done') {
            const r = JSON.parse(data);
            if (r[agentCfg.outputKey]) {
              setResult(r[agentCfg.outputKey]);
              setSummary(r.summary ?? null);
              lastOutput.current[agent] = r[agentCfg.outputKey];
            } else {
              setError(r.error || 'Zod 校验失败');
              setRaw(r.raw ?? '');
            }
            setStatus('done');
          } else if (evt === 'error') {
            setError(JSON.parse(data).message);
            setStatus('error');
          }
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') { setError(err.message); setStatus('error'); }
    }
  }, [agent, agentCfg, inputVal, status]);

  const stop = () => {
    abortRef.current?.abort();
    setStatus((s) => (s === 'running' ? 'idle' : s));
  };

  const bringLast = () => {
    const prev = AGENTS[AGENTS.findIndex((a) => a.key === agent) - 1];
    if (prev && lastOutput.current[prev.key]) {
      setInputVal(JSON.stringify(lastOutput.current[prev.key], null, 2));
    }
  };

  const copyJson = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      const btn = document.activeElement as HTMLButtonElement | null;
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ 已复制';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      }
    } catch { setError('复制失败：浏览器未授予剪贴板权限'); }
  };

  const stageStatus = (a: AgentKey) => {
    if (a === agent) return status === 'running' ? 'running' : status === 'done' && result ? 'done' : status === 'error' ? 'failed' : 'pending';
    return 'pending';
  };

  return (
    <div className="workspace">
      {/* 左：对话/输入面板 */}
      <aside className="ws-panel ws-left">
        <header className="ws-header">
          <span>💬 对话面板</span>
          <span className="ws-sub">{agentCfg.label} · 输入</span>
        </header>

        {/* Agent 选择 Tab */}
        <div className="agent-tabs">
          {AGENTS.map((a) => (
            <button
              key={a.key}
              className={`agent-tab ${a.key === agent ? 'active' : ''}`}
              onClick={() => { setAgent(a.key); setStatus('idle'); setResult(null); setSummary(null); setRaw(''); setError(''); }}
            >
              <span className="tab-icon">{a.icon}</span>
              <span className="tab-label">{a.label}</span>
            </button>
          ))}
        </div>

        <div className="chat-area">
          <p className="hint">{agentCfg.desc}。用于调试提示词与 JSON Schema 效果。</p>

          {agent !== 'prd' && (
            <button
              className="btn btn-bring"
              onClick={bringLast}
              disabled={!lastOutput.current[AGENTS[AGENTS.findIndex((a) => a.key === agent) - 1]?.key]}
            >
              📥 带入上次 {AGENTS[AGENTS.findIndex((a) => a.key === agent) - 1]?.label} 输出
            </button>
          )}

          {agent === 'prd' ? (
            <>
              <textarea
                className="req-input"
                placeholder={agentCfg.inputPlaceholder}
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
              />
              <div className="shortcuts">
                {['做一个团队待办应用', '做一个番茄钟', '做一个记账小程序'].map((s) => (
                  <button key={s} className="chip" onClick={() => setInputVal(s)}>{s}</button>
                ))}
              </div>
            </>
          ) : (
            <textarea
              className="req-input json-input"
              placeholder={agentCfg.inputPlaceholder}
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
            />
          )}
        </div>

        <footer className="send-bar">
          {status === 'running' ? (
            <button className="btn btn-stop" onClick={stop}>停止</button>
          ) : (
            <button className="btn btn-send" onClick={send} disabled={!inputVal.trim()}>
              {status === 'idle' ? `生成 ${agentCfg.label} →` : '重新生成 →'}
            </button>
          )}
          <span className="meta">⌘/Ctrl + Enter 发送</span>
        </footer>
      </aside>

      {/* 中：流水线看板 */}
      <main className="ws-panel ws-mid">
        <header className="ws-header">
          <span>📊 流水线看板</span>
          <span className="ws-sub">{agentCfg.label} 阶段</span>
        </header>
        <div className="pipeline">
          {AGENTS.map((a, i) => {
            const ss = stageStatus(a.key);
            const ssLabel = { pending: '待执行', running: '生成中', done: '已完成', failed: '失败' }[ss];
            const agentSummary = a.key === agent ? summary : null;
            return (
              <div key={a.key} className={`stage stage-${ss} ${a.key === agent ? 'stage-active' : ''}`}>
                <div className="stage-icon">
                  {ss === 'done' ? '✓' : ss === 'running' ? '◐' : ss === 'failed' ? '✕' : i + 1}
                </div>
                <div className="stage-body">
                  <div className="stage-head">
                    <span className="stage-name">{a.label}</span>
                    <span className={`badge badge-${ss}`}>{ssLabel}</span>
                  </div>
                  <p className="stage-desc">{a.desc}</p>
                  {ss === 'running' && <div className="streaming">已接收 {raw.length} 字符…</div>}
                  {agentSummary && <StageSummary agent={a.key} summary={agentSummary} />}
                  {a.key === agent && (status === 'done' || status === 'error') && !result && raw && (
                    <div className="streaming">本次输出未通过 Zod 校验，查看右侧原始输出。</div>
                  )}
                  {a.key === agent && error && <div className="err-box">⚠ {error}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* 右：输出预览 */}
      <aside className="ws-panel ws-right">
        <header className="ws-header">
          <span>📄 {agentCfg.label} 预览</span>
          <span className="ws-sub">
            {result ? (
              <button className="btn btn-copy" onClick={copyJson}>📋 复制 JSON</button>
            ) : (
              <span>{status === 'running' ? '流式原始输出' : '待生成'}</span>
            )}
          </span>
        </header>
        <div className="preview">
          {result ? (
            <ResultView agent={agent} data={result} />
          ) : status === 'running' || raw ? (
            <pre className="raw">{raw}</pre>
          ) : (
            <p className="placeholder">生成的 {agentCfg.label} 结果会显示在这里。</p>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ── 辅助组件 ── */

function StageSummary({ agent, summary }: { agent: AgentKey; summary: Record<string, unknown> }) {
  const warnings = (summary.warnings as string[]) ?? [];
  const render = () => {
    switch (agent) {
      case 'prd':
        return (
          <div className="summary-row">
            <span>功能 <b>{summary.features as number}</b></span>
            <span>P0 <b style={{ color: PRIORITY_COLOR.P0 }}>{summary.p0 as number}</b></span>
            <span>假设 <b>{summary.assumptions as number}</b></span>
            <span>实体 <b>{summary.entities as number}</b></span>
          </div>
        );
      case 'design':
        return (
          <div className="summary-row">
            <span>技术栈 <b>{(summary.techStack as string[])?.length ?? 0}</b></span>
            <span>页面 <b>{summary.pages as number}</b></span>
            <span>实体 <b>{summary.entities as number}</b></span>
            <span>API <b>{summary.apis as number}</b></span>
          </div>
        );
      case 'codegen':
        return (
          <div className="summary-row">
            <span>文件 <b>{summary.files as number}</b></span>
            <span>依赖 <b>{summary.dependencies as number}</b></span>
            <span>备注 <b>{summary.notes as number}</b></span>
          </div>
        );
      case 'deploy':
        return (
          <div className="summary-row">
            <span>目标 <b>{summary.target as string}</b></span>
            <span>状态 <b style={{ color: summary.status === 'success' ? '#22c55e' : '#ef4444' }}>{summary.status as string}</b></span>
            {summary.url ? <span>URL <b>{summary.url as string}</b></span> : null}
          </div>
        );
    }
  };
  return (
    <div className="stage-summary">
      {render()}
      {warnings.map((w) => (<div key={w} className="warn">⚠ {w}</div>))}
    </div>
  );
}

function ResultView({ agent, data }: { agent: AgentKey; data: unknown }) {
  switch (agent) {
    case 'prd': return <PrdView prd={data as PRD} />;
    case 'design': return <DesignView doc={data as DesignDoc} />;
    case 'codegen': return <CodegenView doc={data as CodegenDoc} />;
    case 'deploy': return <DeployView doc={data as DeployDoc} />;
  }
}

function PrdView({ prd }: { prd: PRD }) {
  return (
    <div className="prd">
      <section><h4>概述</h4><p>{prd.overview}</p></section>
      <section><h4>目标用户</h4><div className="tags">{prd.targetUsers.map((u) => (<span key={u} className="tag">{u}</span>))}</div></section>
      <section><h4>功能（{prd.features.length}）</h4>
        <table className="ftable"><thead><tr><th>ID</th><th>功能</th><th>优先级</th><th>说明</th></tr></thead>
          <tbody>{prd.features.map((f) => (
            <tr key={f.id}><td>{f.id}</td><td>{f.name}</td><td><span className="prio" style={{ color: PRIORITY_COLOR[f.priority], borderColor: PRIORITY_COLOR[f.priority] }}>{f.priority}</span></td><td>{f.desc}</td></tr>
          ))}</tbody>
        </table>
      </section>
      <section><h4>用户故事</h4><ul>{prd.userStories.map((s, i) => (<li key={i}>{s}</li>))}</ul></section>
      <section><h4>页面</h4><div className="tags">{prd.pages.map((p) => (<span key={p} className="tag">{p}</span>))}</div></section>
      <section><h4>数据实体</h4><ul>{prd.entities.map((e) => (<li key={e.name}><b>{e.name}</b>: <code>{e.fields.join(', ')}</code></li>))}</ul></section>
      <section><h4>假设</h4><ul>{prd.assumptions.map((a, i) => (<li key={i} className="assume">{a}</li>))}</ul></section>
    </div>
  );
}

function DesignView({ doc }: { doc: DesignDoc }) {
  return (
    <div className="prd">
      <section><h4>技术栈</h4><div className="tags">{doc.techStack.map((t) => (<span key={t} className="tag">{t}</span>))}</div></section>
      <section><h4>架构说明</h4><p>{doc.architecture}</p></section>
      <section><h4>页面路由（{doc.pageTree.length}）</h4>
        <table className="ftable"><thead><tr><th>路径</th><th>组件</th><th>说明</th></tr></thead>
          <tbody>{doc.pageTree.map((p) => (<tr key={p.path}><td><code>{p.path}</code></td><td>{p.component}</td><td>{p.description}</td></tr>))}</tbody>
        </table>
      </section>
      <section><h4>数据模型（{doc.dataModels.length}）</h4>
        {doc.dataModels.map((m) => (
          <div key={m.name} className="data-model">
            <b>{m.name}</b>
            <table className="ftable"><thead><tr><th>字段</th><th>类型</th></tr></thead>
              <tbody>{m.fields.map((f) => (<tr key={f.name}><td>{f.name}</td><td><code>{f.type}</code></td></tr>))}</tbody>
            </table>
          </div>
        ))}
      </section>
      <section><h4>API 接口（{doc.apis.length}）</h4>
        <table className="ftable"><thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead>
          <tbody>{doc.apis.map((a, i) => (
            <tr key={i}><td><span className={`method method-${a.method}`}>{a.method}</span></td><td><code>{a.path}</code></td><td>{a.description}</td></tr>
          ))}</tbody>
        </table>
      </section>
    </div>
  );
}

function CodegenView({ doc }: { doc: CodegenDoc }) {
  const [activeFile, setActiveFile] = useState(0);
  return (
    <div className="prd">
      <section><h4>依赖（{doc.dependencies.length}）</h4><div className="tags">{doc.dependencies.map((d) => (<span key={d} className="tag">{d}</span>))}</div></section>
      <section><h4>启动命令</h4><pre className="code-block">$ {doc.runCommand}</pre></section>
      <section><h4>文件（{doc.files.length}）</h4>
        <div className="file-browser">
          <div className="file-tree">
            {doc.files.map((f, i) => (
              <button key={i} className={`file-item ${i === activeFile ? 'active' : ''}`} onClick={() => setActiveFile(i)}>
                {f.path}
              </button>
            ))}
          </div>
          <pre className="file-content">{doc.files[activeFile]?.content}</pre>
        </div>
      </section>
      {doc.notes.length > 0 && (
        <section><h4>注意事项</h4><ul>{doc.notes.map((n, i) => (<li key={i} className="assume">{n}</li>))}</ul></section>
      )}
    </div>
  );
}

function DeployView({ doc }: { doc: DeployDoc }) {
  return (
    <div className="prd">
      <section><h4>部署状态</h4>
        <div className="deploy-status">
          <span className={`deploy-badge deploy-${doc.status}`}>{doc.status === 'success' ? '✓ 成功' : '✕ 失败'}</span>
          <span className="deploy-target">目标：{doc.target === 'cloud' ? '☁️ 云托管' : '📦 Git 仓库'}</span>
        </div>
      </section>
      {doc.url && (
        <section><h4>访问地址</h4><p><a href={doc.url} target="_blank" rel="noreferrer" className="deploy-url">{doc.url}</a></p></section>
      )}
      {doc.repoUrl && (
        <section><h4>仓库链接</h4><p><a href={doc.repoUrl} target="_blank" rel="noreferrer" className="deploy-url">{doc.repoUrl}</a></p></section>
      )}
      <section><h4>构建日志</h4><pre className="build-log">{doc.buildLog}</pre></section>
    </div>
  );
}

/* ── 工具 ── */
function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
