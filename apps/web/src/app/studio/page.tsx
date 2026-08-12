'use client';

import { useRef, useState, useEffect } from 'react';
type Stage = 'requirement' | 'design' | 'codegen' | 'deploy';
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
interface Codegen {
  files: { path: string; content: string }[];
  dependencies: string[];
  runCommand: string;
  notes: string[];
}
interface Deploy {
  target: 'cloud' | 'git';
  url: string;
  repoUrl: string;
  buildLog: string;
  status: 'success' | 'failed';
}

/** 通用 SSE 流式调用：返回 { data, raw, error } */
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
        return { data: r.prd || r.design || r.codegen || r.deploy, raw: r.raw ?? rawAcc, error: r.error };
      } else if (evt === 'error') {
        return { raw: rawAcc, error: JSON.parse(data).message };
      }
    }
  }
  return { raw: rawAcc };
}

export default function StudioPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) {
    return <div style={{ padding: 40, color: '#9ca3af', fontSize: 13 }} suppressHydrationWarning>加载 Studio…</div>;
  }

  return <StudioPageInner />;
}

function StudioPageInner() {
  const [requirement, setRequirement] = useState('做一个团队待办事项应用，支持任务指派和看板');
  const [reqStatus, setReqStatus] = useState<Status>('pending');
  const [prd, setPrd] = useState<PRD | null>(null);
  const [designStatus, setDesignStatus] = useState<Status>('pending');
  const [design, setDesign] = useState<Design | null>(null);
  const [codegenStatus, setCodegenStatus] = useState<Status>('pending');
  const [codegen, setCodegen] = useState<Codegen | null>(null);
  const [deployStatus, setDeployStatus] = useState<Status>('pending');
  const [deploy, setDeploy] = useState<Deploy | null>(null);
  const [streaming, setStreaming] = useState('');
  const [activeStage, setActiveStage] = useState<Stage | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  function resetDownstream(from: Stage) {
    if (from === 'requirement') {
      setPrd(null); setReqStatus('pending');
      setDesign(null); setDesignStatus('pending');
      setCodegen(null); setCodegenStatus('pending');
      setDeploy(null); setDeployStatus('pending');
    } else if (from === 'design') {
      setDesign(null); setDesignStatus('pending');
      setCodegen(null); setCodegenStatus('pending');
      setDeploy(null); setDeployStatus('pending');
    } else if (from === 'codegen') {
      setCodegen(null); setCodegenStatus('pending');
      setDeploy(null); setDeployStatus('pending');
    } else if (from === 'deploy') {
      setDeploy(null); setDeployStatus('pending');
    }
  }

  async function runRequirement() {
    if (!requirement.trim() || reqStatus === 'running') return;
    setActiveStage('requirement');
    resetDownstream('requirement'); setError(''); setStreaming('');
    setReqStatus('running');
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const r = await streamAgent('/api/prd/generate', { requirement }, (t) => setStreaming(t), ac.signal);
      if (r.error) { setReqStatus('error'); setError(r.error); setStreaming(r.raw); }
      else { setPrd(r.data as PRD); setReqStatus('done'); }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') { setReqStatus('error'); setError((e as Error).message); }
    }
  }

  async function runDesign() {
    if (!prd || designStatus === 'running') return;
    setActiveStage('design');
    resetDownstream('design'); setError(''); setStreaming('');
    setDesignStatus('running');
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const r = await streamAgent('/api/prd/design', { prd }, (t) => setStreaming(t), ac.signal);
      if (r.error) { setDesignStatus('error'); setError(r.error); setStreaming(r.raw); }
      else { setDesign(r.data as Design); setDesignStatus('done'); }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') { setDesignStatus('error'); setError((e as Error).message); }
    }
  }

  async function runCodegen() {
    if (!design || codegenStatus === 'running') return;
    setActiveStage('codegen');
    resetDownstream('codegen'); setError(''); setStreaming('');
    setCodegenStatus('running');
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const r = await streamAgent('/api/prd/codegen', { design }, (t) => setStreaming(t), ac.signal);
      if (r.error) { setCodegenStatus('error'); setError(r.error); setStreaming(r.raw); }
      else { setCodegen(r.data as Codegen); setCodegenStatus('done'); }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') { setCodegenStatus('error'); setError((e as Error).message); }
    }
  }

  async function runDeploy() {
    if (!codegen || deployStatus === 'running') return;
    setActiveStage('deploy');
    resetDownstream('deploy'); setError(''); setStreaming('');
    setDeployStatus('running');
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const r = await streamAgent('/api/prd/deploy', { codegen }, (t) => setStreaming(t), ac.signal);
      if (r.error) { setDeployStatus('error'); setError(r.error); setStreaming(r.raw); }
      else { setDeploy(r.data as Deploy); setDeployStatus('done'); }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') { setDeployStatus('error'); setError((e as Error).message); }
    }
  }

  function stop() {
    abortRef.current?.abort();
    if (reqStatus === 'running') setReqStatus('pending');
    if (designStatus === 'running') setDesignStatus('pending');
    if (codegenStatus === 'running') setCodegenStatus('pending');
    if (deployStatus === 'running') setDeployStatus('pending');
    setActiveStage(null);
  }

  const isRunning = reqStatus === 'running' || designStatus === 'running' || codegenStatus === 'running' || deployStatus === 'running';
  const showStream = activeStage && isRunning;

  const previewLabel = deploy ? 'DeployDocument' : codegen ? 'CodegenDocument' : design ? 'DesignDocument' : prd ? 'PRD' : '待生成';

  return (
    <div className="page">
      <header className="topbar">
        <span className="logo">🚀 AppLoom · Studio</span>
        <span className="sub">生产端 · 4-Agent 流水线</span>
      </header>

      {/* 全宽 Loading Banner —— 绝对显眼 */}
      {isRunning && (
        <div style={{
          padding: '14px 24px', background: 'linear-gradient(90deg, #3b82f6, #2563eb)',
          color: '#fff', fontSize: 15, fontWeight: 600, textAlign: 'center',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          boxShadow: '0 2px 8px rgba(59,130,246,0.4)', position: 'sticky', top: 0, zIndex: 100,
          animation: 'studio-pulse-bg 1.5s ease-in-out infinite',
        }}>
          <span style={{
            width: 20, height: 20, border: '3px solid rgba(255,255,255,0.4)', borderTopColor: '#fff',
            borderRadius: '50%', display: 'inline-block', flexShrink: 0,
            animation: 'studio-spin 0.8s linear infinite',
          }} />
          <span>
            ⏳ 正在生成 <b style={{ marginLeft: 4 }}>
              {activeStage === 'requirement' ? '需求拆解' : activeStage === 'design' ? '方案设计' : activeStage === 'codegen' ? '代码生成' : activeStage === 'deploy' ? '部署发布' : ''}
            </b>
            · 已接收 <b style={{ marginLeft: 4 }}>{streaming.length}</b> 字符
          </span>
          <button onClick={stop} style={{
            marginLeft: 12, padding: '4px 12px', background: 'rgba(255,255,255,0.2)',
            border: '1px solid rgba(255,255,255,0.4)', borderRadius: 6, color: '#fff',
            fontSize: 12, cursor: 'pointer', fontWeight: 500,
          }}>停止</button>
        </div>
      )}

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
              {isRunning ? (
                <button className="btn btn-stop" onClick={stop}>停止</button>
              ) : (
                <button className="btn btn-primary" onClick={runRequirement} disabled={!requirement.trim()}>
                  {reqStatus === 'done' ? '重新生成 PRD' : '生成 PRD →'}
                </button>
              )}
            </div>
            {isRunning && (
              <div style={{
                marginTop: 12, padding: '12px 14px', background: '#eff6ff',
                border: '2px solid #3b82f6', borderRadius: 10, fontSize: 13, color: '#1e40af',
                display: 'flex', alignItems: 'center', gap: 10, fontWeight: 500,
              }}>
                <span style={{
                  width: 18, height: 18, border: '3px solid #bfdbfe', borderTopColor: '#3b82f6',
                  borderRadius: '50%', display: 'inline-block', flexShrink: 0,
                  animation: 'studio-spin 0.8s linear infinite',
                }} />
                <span>
                  ◐ 正在执行：<b>{activeStage === 'requirement' ? '需求拆解' : activeStage === 'design' ? '方案设计' : activeStage === 'codegen' ? '代码生成' : activeStage === 'deploy' ? '部署发布' : ''}</b>
                  · 已接收 <b>{streaming.length}</b> 字符
                </span>
              </div>
            )}
          </section>

          <div className="pipeline">
            {/* Stage 1: 需求拆解 */}
            <div className={`stage stage-${reqStatus}`}>
              <div className="stage-head">
                <span className="stage-num">{statusIcon(reqStatus, 1)}</span>
                <span className="stage-title">需求拆解</span>
                <span className={`badge badge-${reqStatus}`}>{statusLabel(reqStatus)}</span>
              </div>
              {reqStatus === 'running' && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#3b82f6' }}>
                  ◐ 已接收 {streaming.length} 字符…
                </div>
              )}
              {prd && (
                <div className="stage-body">
                  <div className="meta-row">
                    <span>功能 {prd.features.length}</span>
                    <span>P0 {prd.features.filter((f) => f.priority === 'P0').length}</span>
                    <span>假设 {prd.assumptions.length}</span>
                    <span>实体 {prd.entities.length}</span>
                  </div>
                  {reqStatus === 'done' && designStatus === 'pending' && (
                    <button className="btn btn-next" onClick={runDesign}>下一步 → 方案设计</button>
                  )}
                </div>
              )}
            </div>

            <div className="connector" />

            {/* Stage 2: 方案设计 */}
            <div className={`stage stage-${designStatus}`}>
              <div className="stage-head">
                <span className="stage-num">{statusIcon(designStatus, 2)}</span>
                <span className="stage-title">方案设计</span>
                <span className={`badge badge-${designStatus}`}>{statusLabel(designStatus)}</span>
              </div>
              {designStatus === 'running' && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#3b82f6' }}>
                  ◐ 已接收 {streaming.length} 字符…
                </div>
              )}
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
                  {designStatus === 'done' && codegenStatus === 'pending' && (
                    <button className="btn btn-next" onClick={runCodegen}>下一步 → 代码生成</button>
                  )}
                </div>
              )}
            </div>

            <div className="connector" />

            {/* Stage 3: 代码生成 */}
            <div className={`stage stage-${codegenStatus}`}>
              <div className="stage-head">
                <span className="stage-num">{statusIcon(codegenStatus, 3)}</span>
                <span className="stage-title">代码生成</span>
                <span className={`badge badge-${codegenStatus}`}>{statusLabel(codegenStatus)}</span>
              </div>
              {codegenStatus === 'running' && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#3b82f6' }}>
                  ◐ 已接收 {streaming.length} 字符…
                </div>
              )}
              {codegen && (
                <div className="stage-body">
                  <div className="meta-row">
                    <span>文件 {codegen.files.length}</span>
                    <span>依赖 {codegen.dependencies.length}</span>
                    <span>注意 {codegen.notes.length}</span>
                  </div>
                  {codegenStatus === 'done' && deployStatus === 'pending' && (
                    <button className="btn btn-next" onClick={runDeploy}>下一步 → 部署发布</button>
                  )}
                </div>
              )}
            </div>

            <div className="connector" />

            {/* Stage 4: 部署发布 */}
            <div className={`stage stage-${deployStatus}`}>
              <div className="stage-head">
                <span className="stage-num">{statusIcon(deployStatus, 4)}</span>
                <span className="stage-title">部署发布</span>
                <span className={`badge badge-${deployStatus}`}>{statusLabel(deployStatus)}</span>
              </div>
              {deployStatus === 'running' && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#3b82f6' }}>
                  ◐ 已接收 {streaming.length} 字符…
                </div>
              )}
              {deploy && (
                <div className="stage-body">
                  <div className="meta-row">
                    <span>目标 {deploy.target === 'cloud' ? '云托管' : 'Git 导出'}</span>
                    <span className={deploy.status === 'success' ? 'ok' : 'fail'}>{deploy.status === 'success' ? '✓ 成功' : '✗ 失败'}</span>
                  </div>
                  {deploy.url && <a className="deploy-url" href={deploy.url} target="_blank" rel="noopener noreferrer">{deploy.url}</a>}
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
                <div style={{
                  marginBottom: 12, padding: '10px 12px', background: '#eff6ff',
                  borderRadius: 8, border: '1px solid #bfdbfe', fontSize: 12, color: '#3b82f6',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{
                    width: 14, height: 14, border: '2px solid #bfdbfe', borderTopColor: '#3b82f6',
                    borderRadius: '50%', display: 'inline-block', flexShrink: 0,
                    animation: 'studio-spin 0.8s linear infinite',
                  }} />
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
            ) : prd ? (
              <PrdView prd={prd} />
            ) : (
              <p className="ph">输入一句话需求，依次经过 4 个 Agent：需求拆解 → 方案设计 → 代码生成 → 部署发布。</p>
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
        .stage-running .stage-num { background:#3b82f6; color:#fff; animation:spin 1.2s linear infinite; }
        .stage-done .stage-num { background:#10b981; color:#fff; }
        .stage-error .stage-num { background:#ef4444; color:#fff; }
        @keyframes spin { to { transform:rotate(360deg); } }
        @keyframes studio-spin { to { transform:rotate(360deg); } }
        @keyframes studio-blink { 0%,50% { opacity:1; } 51%,100% { opacity:0; } }
        @keyframes studio-pulse-bg { 0%,100% { background:linear-gradient(90deg, #3b82f6, #2563eb); } 50% { background:linear-gradient(90deg, #60a5fa, #3b82f6); } }
        .studio-cursor-blink { display:inline-block; color:#3b82f6; animation:studio-blink 1s step-end infinite; }
        .stage-title { font-weight:600; font-size:14px; flex:1; }
        .badge { font-size:11px; padding:2px 8px; border-radius:999px; }
        .badge-pending { background:#f0f1f3; color:#6b7280; }
        .badge-running { background:#eff6ff; color:#3b82f6; }
        .badge-done { background:#ecfdf5; color:#10b981; }
        .badge-error { background:#fef2f2; color:#ef4444; }
        .stage-body { margin-top:10px; display:flex; flex-direction:column; gap:10px; }
        .meta-row { display:flex; gap:16px; font-size:12px; color:#6b7280; }
        .meta-row .ok { color:#10b981; font-weight:600; }
        .meta-row .fail { color:#ef4444; font-weight:600; }
        .techstack { display:flex; flex-wrap:wrap; gap:6px; }
        .tk { font-size:11px; padding:3px 8px; background:#eff6ff; color:#3b82f6; border-radius:6px; border:1px solid #93c5fd; }
        .connector { width:2px; height:20px; background:#e5e7eb; margin-left:24px; align-self:flex-start; }
        .deploy-url { font-size:12px; color:#3b82f6; text-decoration:none; word-break:break-all; }
        .deploy-url:hover { text-decoration:underline; }
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
        .file-tree { font-family:'SF Mono',monospace; font-size:11px; }
        .file-item { padding:3px 0; cursor:pointer; color:#3b82f6; }
        .file-item:hover { text-decoration:underline; }
        .code-block { font-family:'SF Mono',monospace; font-size:10px; background:#f7f8fa; border:1px solid #e5e7eb; border-radius:6px; padding:8px; overflow-x:auto; white-space:pre; max-height:200px; overflow-y:auto; }
        .deploy-success { color:#10b981; font-weight:600; }
        .deploy-failed { color:#ef4444; font-weight:600; }
        .build-log { font-family:'SF Mono',monospace; font-size:11px; background:#1a1a2e; color:#a7f3d0; border-radius:6px; padding:10px; white-space:pre-wrap; word-break:break-all; }
      `}</style>
    </div>
  );
}

function statusLabel(s: Status) {
  return { pending: '待执行', running: '生成中', done: '已完成', error: '失败' }[s];
}

function statusIcon(s: Status, num: number) {
  if (s === 'done') return '✓';
  if (s === 'running') return '◐';
  if (s === 'error') return '✕';
  return num;
}

const STAGE_STEPS: Record<Stage, string[]> = {
  requirement: ['解析一句话需求', '识别目标用户与场景', '拆解功能与优先级', '抽取数据实体', '生成假设与验收点'],
  design: ['阅读 PRD', '决策技术栈', '设计页面路由', '设计数据模型', '设计 API 接口'],
  codegen: ['阅读 Design', '规划文件结构', '生成页面组件', '生成 API 路由', '生成配置与依赖'],
  deploy: ['阅读 Codegen', '准备构建环境', '安装依赖', '执行构建', '发布到云端'],
};

function StageLoading({ stage, streaming }: { stage: Stage; streaming: string }) {
  const steps = STAGE_STEPS[stage];
  // 根据已接收字符数估算进度（每步约 200 字符推进）
  const progress = Math.min(steps.length, Math.floor(streaming.length / 200) + 1);
  return (
    <div className="studio-stage-loading" style={{
      marginTop: 12, padding: 12, background: '#f8faff', border: '2px solid #3b82f6', borderRadius: 8,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{
          width: 18, height: 18, border: '2px solid #bfdbfe', borderTopColor: '#3b82f6',
          borderRadius: '50%', display: 'inline-block', flexShrink: 0, marginTop: 2,
          animation: 'studio-spin 0.8s linear infinite',
        }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {steps.map((s, i) => {
            const cls = i < progress ? 'studio-step-done' : i === progress ? 'studio-step-active' : 'studio-step-pending';
            const color = i < progress ? '#10b981' : i === progress ? '#3b82f6' : '#9ca3af';
            return (
              <div key={s} className={`studio-step ${cls}`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color }}>
                <span style={{ width: 14, textAlign: 'center' }}>
                  {i < progress ? '✓' : i === progress ? '●' : '○'}
                </span>
                <span>{s}</span>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', minWidth: 80 }}>
          <span style={{ fontSize: 10, color: '#6b7280', fontFamily: 'SF Mono,monospace' }}>{streaming.length} 字符</span>
          <div style={{ width: 80, height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${(progress / steps.length) * 100}%`,
              background: 'linear-gradient(90deg,#3b82f6,#60a5fa)', borderRadius: 2, transition: 'width 0.4s ease',
            }} />
          </div>
        </div>
      </div>
      {streaming && (
        <div style={{
          fontFamily: 'SF Mono,monospace', fontSize: 10, lineHeight: 1.5, color: '#6b7280',
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 8px',
          maxHeight: 60, overflow: 'hidden', wordBreak: 'break-all',
        }}>
          <span style={{ color: '#3b82f6', fontWeight: 600 }}>实时输出：</span>
          <span style={{ color: '#9ca3af' }}>{streaming.slice(-120)}</span>
          <span style={{ display: 'inline-block', color: '#3b82f6', animation: 'studio-blink 1s step-end infinite' }}>▋</span>
        </div>
      )}
    </div>
  );
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

function CodegenView({ codegen }: { codegen: Codegen }) {
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

function DeployView({ deploy }: { deploy: Deploy }) {
  return (
    <div>
      <section><h4>部署状态</h4>
        <p className={deploy.status === 'success' ? 'deploy-success' : 'deploy-failed'}>
          {deploy.status === 'success' ? '✓ 部署成功' : '✗ 部署失败'}
        </p>
      </section>
      <section><h4>部署目标</h4>
        <p>{deploy.target === 'cloud' ? '☁ 内置云托管' : '📦 Git 仓库导出'}</p>
      </section>
      {deploy.url && (
        <section><h4>访问地址</h4>
          <a href={deploy.url} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', fontSize: 12, wordBreak: 'break-all' }}>{deploy.url}</a>
        </section>
      )}
      {deploy.repoUrl && (
        <section><h4>仓库链接</h4>
          <a href={deploy.repoUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', fontSize: 12, wordBreak: 'break-all' }}>{deploy.repoUrl}</a>
        </section>
      )}
      <section><h4>构建日志</h4>
        <div className="build-log">{deploy.buildLog}</div>
      </section>
    </div>
  );
}
