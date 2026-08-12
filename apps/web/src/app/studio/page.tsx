'use client';

import { useRef, useState } from 'react';

type Stage = 'requirement' | 'design';
type Status = 'pending' | 'running' | 'done' | 'error';

interface Feature { id: string; name: string; priority: 'P0' | 'P1' | 'P2'; desc: string; }
interface PRD {
  overview: string; targetUsers: string[]; features: Feature[];
  userStories: string[]; pages: string[];
  entities: { name: string; fields: string[] }[];
  assumptions: string[];
}
interface Design {
  techStack: string[]; architecture: string;
  pageTree: { path: string; component: string; description: string }[];
  dataModels: { name: string; fields: { name: string; type: string }[] }[];
  apis: { method: string; path: string; description: string }[];
}

/** 通用 SSE 流式调用：返回 { prd/design, raw, error } */
async function streamAgent(
  url: string,
  body: object,
  onToken: (t: string) => void,
  signal?: AbortSignal,
): Promise<{ data?: unknown; raw: string; error?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
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
        onToken(rawAcc);
      } else if (evt === 'done') {
        const r = JSON.parse(data);
        return { data: r.prd || r.design, raw: r.raw ?? rawAcc, error: r.error };
      } else if (evt === 'error') {
        return { raw: rawAcc, error: JSON.parse(data).message };
      }
    }
  }
  return { raw: rawAcc };
}

export default function StudioPage() {
  const [requirement, setRequirement] = useState('做一个团队待办事项应用，支持任务指派和看板');
  const [reqStatus, setReqStatus] = useState<Status>('pending');
  const [prd, setPrd] = useState<PRD | null>(null);
  const [designStatus, setDesignStatus] = useState<Status>('pending');
  const [design, setDesign] = useState<Design | null>(null);
  const [streaming, setStreaming] = useState('');
  const [activeStage, setActiveStage] = useState<Stage | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  async function runRequirement() {
    if (!requirement.trim() || reqStatus === 'running') return;
    setReqStatus('running'); setActiveStage('requirement');
    setPrd(null); setDesign(null); setDesignStatus('pending'); setError(''); setStreaming('');
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const r = await streamAgent(
        '/api/prd/generate',
        { requirement },
        (t) => setStreaming(t),
        ac.signal,
      );
      if (r.error) { setReqStatus('error'); setError(r.error); setStreaming(r.raw); }
      else { setPrd(r.data as PRD); setReqStatus('done'); }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') { setReqStatus('error'); setError((e as Error).message); }
    }
  }

  async function runDesign() {
    if (!prd || designStatus === 'running') return;
    setDesignStatus('running'); setActiveStage('design');
    setDesign(null); setError(''); setStreaming('');
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const r = await streamAgent(
        '/api/prd/design',
        { prd },
        (t) => setStreaming(t),
        ac.signal,
      );
      if (r.error) { setDesignStatus('error'); setError(r.error); setStreaming(r.raw); }
      else { setDesign(r.data as Design); setDesignStatus('done'); }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') { setDesignStatus('error'); setError((e as Error).message); }
    }
  }

  function stop() {
    abortRef.current?.abort();
    if (reqStatus === 'running') setReqStatus('pending');
    if (designStatus === 'running') setDesignStatus('pending');
    setActiveStage(null);
  }

  const showStream = activeStage && (reqStatus === 'running' || designStatus === 'running' || (!prd && !design && streaming));

  return (
    <div className="page">
      <header className="topbar">
        <span className="logo">🚀 AppLoom · Studio</span>
        <span className="sub">生产端 · 多 Agent 流水线</span>
      </header>

      <div className="layout">
        {/* 左：输入 + 流水线 */}
        <main className="main">
          <section className="input-card">
            <label className="lbl">一句话需求</label>
            <textarea
              className="ta"
              placeholder="例如：做一个团队待办事项应用，支持任务指派和看板"
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
            />
            <div className="row">
              {(reqStatus === 'running' || designStatus === 'running') ? (
                <button className="btn btn-stop" onClick={stop}>停止</button>
              ) : (
                <button className="btn btn-primary" onClick={runRequirement} disabled={!requirement.trim()}>
                  {reqStatus === 'done' ? '重新生成 PRD' : '生成 PRD →'}
                </button>
              )}
            </div>
          </section>

          <div className="pipeline">
            {/* Stage 1: 需求拆解 */}
            <div className={`stage stage-${reqStatus}`}>
              <div className="stage-head">
                <span className="stage-num">1</span>
                <span className="stage-title">需求拆解</span>
                <span className={`badge badge-${reqStatus}`}>{statusLabel(reqStatus)}</span>
              </div>
              {prd && (
                <div className="stage-body">
                  <div className="meta-row">
                    <span>功能 {prd.features.length}</span>
                    <span>P0 {prd.features.filter((f) => f.priority === 'P0').length}</span>
                    <span>假设 {prd.assumptions.length}</span>
                    <span>实体 {prd.entities.length}</span>
                  </div>
                  {prd && reqStatus === 'done' && designStatus === 'pending' && (
                    <button className="btn btn-next" onClick={runDesign}>
                      下一步 → 方案设计
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="connector" />

            {/* Stage 2: 方案设计 */}
            <div className={`stage stage-${designStatus}`}>
              <div className="stage-head">
                <span className="stage-num">2</span>
                <span className="stage-title">方案设计</span>
                <span className={`badge badge-${designStatus}`}>{statusLabel(designStatus)}</span>
              </div>
              {design && (
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
              )}
            </div>
          </div>

          {error && <div className="err">⚠ {error}</div>}
        </main>

        {/* 右：产出预览 */}
        <aside className="preview">
          <header className="pv-header">
            <span>产出预览</span>
            <span className="pv-sub">{prd ? (design ? 'DesignDocument' : 'PRD') : '待生成'}</span>
          </header>
          <div className="pv-body">
            {showStream ? (
              <pre className="raw">{streaming}</pre>
            ) : design ? (
              <DesignView design={design} />
            ) : prd ? (
              <PrdView prd={prd} />
            ) : (
              <p className="ph">输入一句话需求，生成 PRD 后点「下一步」进入方案设计。</p>
            )}
          </div>
        </aside>
      </div>

      <style>{`
        .page { height:100vh; display:flex; flex-direction:column; background:#f7f8fa; color:#1a1a2e; font-family:-apple-system,'PingFang SC',sans-serif; }
        .topbar { display:flex; align-items:center; justify-content:space-between; padding:12px 24px; background:#fff; border-bottom:1px solid #e5e7eb; }
        .logo { font-weight:700; font-size:15px; }
        .sub { font-size:12px; color:#9ca3af; }
        .layout { flex:1; display:flex; overflow:hidden; }
        .main { flex:1; overflow-y:auto; padding:24px; display:flex; flex-direction:column; gap:16px; max-width:680px; }
        .input-card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:10px; }
        .lbl { font-size:12px; color:#6b7280; font-weight:600; }
        .ta { width:100%; min-height:80px; resize:vertical; padding:10px 12px; border:1px solid #e5e7eb; border-radius:8px; font-size:14px; line-height:1.6; font-family:inherit; box-sizing:border-box; }
        .ta:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px #eff6ff; }
        .row { display:flex; gap:8px; }
        .btn { border:none; border-radius:8px; padding:8px 16px; font-size:13px; cursor:pointer; font-weight:500; }
        .btn-primary { background:#3b82f6; color:#fff; }
        .btn-primary:hover { background:#2563eb; }
        .btn-primary:disabled { background:#d1d5db; cursor:not-allowed; }
        .btn-stop { background:#ef4444; color:#fff; }
        .btn-next { background:#10b981; color:#fff; }
        .btn-next:hover { background:#059669; }
        .pipeline { display:flex; flex-direction:column; align-items:stretch; }
        .stage { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px 16px; }
        .stage-pending { opacity:0.6; }
        .stage-running { border-color:#3b82f6; box-shadow:0 0 0 3px #eff6ff; }
        .stage-done { border-color:#10b981; }
        .stage-error { border-color:#ef4444; }
        .stage-head { display:flex; align-items:center; gap:10px; }
        .stage-num { width:24px; height:24px; border-radius:50%; background:#f0f1f3; color:#6b7280; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
        .stage-running .stage-num { background:#3b82f6; color:#fff; }
        .stage-done .stage-num { background:#10b981; color:#fff; }
        .stage-error .stage-num { background:#ef4444; color:#fff; }
        .stage-title { font-weight:600; font-size:14px; flex:1; }
        .badge { font-size:11px; padding:2px 8px; border-radius:999px; }
        .badge-pending { background:#f0f1f3; color:#6b7280; }
        .badge-running { background:#eff6ff; color:#3b82f6; }
        .badge-done { background:#ecfdf5; color:#10b981; }
        .badge-error { background:#fef2f2; color:#ef4444; }
        .stage-body { margin-top:10px; display:flex; flex-direction:column; gap:10px; }
        .meta-row { display:flex; gap:16px; font-size:12px; color:#6b7280; }
        .techstack { display:flex; flex-wrap:wrap; gap:6px; }
        .tk { font-size:11px; padding:3px 8px; background:#eff6ff; color:#3b82f6; border-radius:6px; border:1px solid #93c5fd; }
        .connector { width:2px; height:20px; background:#e5e7eb; margin-left:24px; align-self:flex-start; }
        .err { font-size:12px; color:#ef4444; background:#fef2f2; border:1px solid #fca5a5; border-radius:8px; padding:10px 12px; }
        .preview { width:400px; background:#fff; border-left:1px solid #e5e7eb; display:flex; flex-direction:column; flex-shrink:0; }
        .pv-header { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-bottom:1px solid #e5e7eb; font-size:14px; font-weight:600; }
        .pv-sub { font-size:12px; color:#9ca3af; font-weight:400; }
        .pv-body { flex:1; overflow-y:auto; padding:16px 18px; }
        .ph { color:#9ca3af; font-size:13px; line-height:1.7; }
        .raw { font-family:'SF Mono',monospace; font-size:11px; white-space:pre-wrap; word-break:break-all; color:#374151; margin:0; line-height:1.6; }
        .pv-body section { margin-bottom:16px; }
        .pv-body h4 { margin:0 0 6px; font-size:12px; font-weight:600; }
        .pv-body p { margin:0; font-size:12px; line-height:1.6; color:#374151; }
        .pv-body ul { margin:0; padding-left:16px; }
        .pv-body li { font-size:12px; line-height:1.6; color:#374151; }
        .tags { display:flex; flex-wrap:wrap; gap:4px; }
        .tag { font-size:11px; padding:2px 7px; background:#f0f1f3; border-radius:5px; color:#6b7280; }
        table.ft { width:100%; border-collapse:collapse; font-size:11px; }
        table.ft th, table.ft td { border:1px solid #e5e7eb; padding:4px 6px; text-align:left; }
        table.ft th { background:#f7f8fa; }
        .prio { display:inline-block; padding:1px 5px; border:1px solid; border-radius:3px; font-size:10px; font-weight:600; }
      `}</style>
    </div>
  );
}

function statusLabel(s: Status) {
  return { pending: '待执行', running: '生成中', done: '已完成', error: '失败' }[s];
}

function PrdView({ prd }: { prd: PRD }) {
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

function DesignView({ design }: { design: Design }) {
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
