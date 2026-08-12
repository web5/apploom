'use client';

import { useRef, useState } from 'react';

type Status = 'idle' | 'running' | 'done' | 'error';
type Priority = 'P0' | 'P1' | 'P2';

interface Feature {
  id: string;
  name: string;
  priority: Priority;
  desc: string;
}
interface Entity {
  name: string;
  fields: string[];
}
interface PRD {
  overview: string;
  targetUsers: string[];
  features: Feature[];
  userStories: string[];
  pages: string[];
  entities: Entity[];
  assumptions: string[];
}
interface Summary {
  features: number;
  p0: number;
  assumptions: number;
  entities: number;
  warnings: string[];
}

const PRIORITY_COLOR: Record<Priority, string> = {
  P0: '#ef4444',
  P1: '#f59e0b',
  P2: '#8b5cf6',
};

export default function DebugPage() {
  const [requirement, setRequirement] = useState('做一个团队待办事项应用，支持任务指派和看板');
  const [status, setStatus] = useState<Status>('idle');
  const [raw, setRaw] = useState('');
  const [prd, setPrd] = useState<PRD | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  async function send() {
    if (!requirement.trim() || status === 'running') return;
    setStatus('running');
    setRaw('');
    setPrd(null);
    setSummary(null);
    setError('');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/api/prd/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirement }),
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
            if (r.prd) {
              setPrd(r.prd);
              setSummary(r.summary);
            } else {
              setError(r.error || 'PRD 校验失败');
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
      if (err.name !== 'AbortError') {
        setError(err.message);
        setStatus('error');
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStatus((s) => (s === 'running' ? 'idle' : s));
  }

  const stageStatus =
    status === 'running' ? 'running' : status === 'done' && prd ? 'done' : status === 'error' ? 'failed' : 'pending';
  const stageLabel = { pending: '待执行', running: '生成中', done: '已完成', failed: '失败' }[stageStatus];

  return (
    <div className="workspace">
      {/* 左：对话/输入面板 */}
      <aside className="ws-panel ws-left">
        <header className="ws-header">
          <span>💬 对话面板</span>
          <span className="ws-sub">需求输入</span>
        </header>
        <div className="chat-area">
          <p className="hint">
            输入一句话需求，AI 需求分析 Agent 会产出结构化 PRD。用于调试提示词与 JSON Schema 效果。
          </p>
          <textarea
            className="req-input"
            placeholder="例如：做一个团队待办事项应用，支持任务指派和看板"
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
            }}
          />
          <div className="shortcuts">
            {['做一个团队待办应用', '做一个番茄钟', '做一个记账小程序'].map((s) => (
              <button key={s} className="chip" onClick={() => setRequirement(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <footer className="send-bar">
          {status === 'running' ? (
            <button className="btn btn-stop" onClick={stop}>
              停止
            </button>
          ) : (
            <button className="btn btn-send" onClick={send} disabled={!requirement.trim()}>
              生成 PRD →
            </button>
          )}
          <span className="meta">⌘/Ctrl + Enter 发送</span>
        </footer>
      </aside>

      {/* 中：流水线看板 */}
      <main className="ws-panel ws-mid">
        <header className="ws-header">
          <span>📊 流水线看板</span>
          <span className="ws-sub">需求拆解阶段</span>
        </header>
        <div className="pipeline">
          <div className={`stage stage-${stageStatus}`}>
            <div className="stage-icon">
              {stageStatus === 'done' ? '✓' : stageStatus === 'running' ? '◐' : stageStatus === 'failed' ? '✕' : '1'}
            </div>
            <div className="stage-body">
              <div className="stage-head">
                <span className="stage-name">需求拆解</span>
                <span className={`badge badge-${stageStatus}`}>{stageLabel}</span>
              </div>
              <p className="stage-desc">
                需求分析 Agent 把一句话拆解为结构化 PRD（功能 / 用户故事 / 页面 / 实体 / 假设）。
              </p>
              {status === 'running' && <div className="streaming">已接收 {raw.length} 字符…</div>}
              {summary && (
                <div className="stage-summary">
                  <div className="summary-row">
                    <span>功能 <b>{summary.features}</b></span>
                    <span>P0 <b style={{ color: PRIORITY_COLOR.P0 }}>{summary.p0}</b></span>
                    <span>假设 <b>{summary.assumptions}</b></span>
                    <span>实体 <b>{summary.entities}</b></span>
                  </div>
                  {summary.warnings.map((w) => (
                    <div key={w} className="warn">⚠ {w}</div>
                  ))}
                </div>
              )}
              {error && <div className="err-box">⚠ {error}</div>}
            </div>
          </div>
        </div>
      </main>

      {/* 右：PRD 预览 */}
      <aside className="ws-panel ws-right">
        <header className="ws-header">
          <span>📄 PRD 预览</span>
          <span className="ws-sub">{prd ? '结构化' : status === 'running' ? '流式原始输出' : '待生成'}</span>
        </header>
        <div className="preview">
          {prd ? (
            <div className="prd">
              <section>
                <h4>概述</h4>
                <p>{prd.overview}</p>
              </section>
              <section>
                <h4>目标用户</h4>
                <div className="tags">
                  {prd.targetUsers.map((u) => (
                    <span key={u} className="tag">{u}</span>
                  ))}
                </div>
              </section>
              <section>
                <h4>功能（{prd.features.length}）</h4>
                <table className="ftable">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>功能</th>
                      <th>优先级</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prd.features.map((f) => (
                      <tr key={f.id}>
                        <td>{f.id}</td>
                        <td>{f.name}</td>
                        <td>
                          <span className="prio" style={{ color: PRIORITY_COLOR[f.priority], borderColor: PRIORITY_COLOR[f.priority] }}>
                            {f.priority}
                          </span>
                        </td>
                        <td>{f.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section>
                <h4>用户故事</h4>
                <ul>
                  {prd.userStories.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h4>页面</h4>
                <div className="tags">
                  {prd.pages.map((p) => (
                    <span key={p} className="tag">{p}</span>
                  ))}
                </div>
              </section>
              <section>
                <h4>数据实体</h4>
                <ul>
                  {prd.entities.map((e) => (
                    <li key={e.name}>
                      <b>{e.name}</b>: <code>{e.fields.join(', ')}</code>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h4>假设</h4>
                <ul>
                  {prd.assumptions.map((a, i) => (
                    <li key={i} className="assume">{a}</li>
                  ))}
                </ul>
              </section>
            </div>
          ) : status === 'running' || raw ? (
            <pre className="raw">{raw}</pre>
          ) : (
            <p className="placeholder">生成的 PRD 会显示在这里。可对照右上方摘要里的 P0 数量、假设条数判断提示词效果。</p>
          )}
        </div>
      </aside>

      <style>{`
        .workspace { display:flex; height:100vh; overflow:hidden; background:#f7f8fa; color:#1a1a2e; font-family: -apple-system, 'PingFang SC', sans-serif; }
        .ws-panel { display:flex; flex-direction:column; overflow:hidden; background:#fff; }
        .ws-left { width:340px; border-right:1px solid #e5e7eb; flex-shrink:0; }
        .ws-mid { flex:1; background:#f7f8fa; min-width:0; }
        .ws-right { width:420px; border-left:1px solid #e5e7eb; flex-shrink:0; }
        .ws-header { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #e5e7eb; font-size:14px; font-weight:600; background:#fff; }
        .ws-sub { font-size:12px; color:#9ca3af; font-weight:400; }
        .chat-area { flex:1; overflow-y:auto; padding:16px 18px; display:flex; flex-direction:column; gap:12px; }
        .hint { font-size:12px; color:#6b7280; line-height:1.6; margin:0; }
        .req-input { width:100%; min-height:120px; resize:vertical; padding:10px 12px; border:1px solid #e5e7eb; border-radius:8px; font-size:14px; line-height:1.5; font-family:inherit; box-sizing:border-box; }
        .req-input:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px #eff6ff; }
        .shortcuts { display:flex; flex-wrap:wrap; gap:6px; }
        .chip { font-size:12px; padding:4px 10px; border:1px solid #e5e7eb; border-radius:999px; background:#fff; cursor:pointer; color:#6b7280; }
        .chip:hover { border-color:#93c5fd; color:#3b82f6; }
        .send-bar { padding:12px 18px; border-top:1px solid #e5e7eb; display:flex; align-items:center; gap:12px; }
        .btn { border:none; border-radius:8px; padding:8px 16px; font-size:14px; cursor:pointer; }
        .btn-send { background:#3b82f6; color:#fff; }
        .btn-send:hover { background:#2563eb; }
        .btn-send:disabled { background:#d1d5db; cursor:not-allowed; }
        .btn-stop { background:#ef4444; color:#fff; }
        .meta { font-size:11px; color:#9ca3af; }
        .pipeline { flex:1; overflow-y:auto; padding:20px; }
        .stage { display:flex; gap:14px; }
        .stage-icon { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:600; flex-shrink:0; background:#f0f1f3; color:#6b7280; }
        .stage-running .stage-icon { background:#eff6ff; color:#3b82f6; animation:spin 1.2s linear infinite; }
        .stage-done .stage-icon { background:#ecfdf5; color:#10b981; }
        .stage-failed .stage-icon { background:#fef2f2; color:#ef4444; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .stage-body { flex:1; min-width:0; }
        .stage-head { display:flex; align-items:center; gap:10px; }
        .stage-name { font-weight:600; font-size:14px; }
        .badge { font-size:11px; padding:2px 8px; border-radius:999px; }
        .badge-pending { background:#f0f1f3; color:#6b7280; }
        .badge-running { background:#eff6ff; color:#3b82f6; }
        .badge-done { background:#ecfdf5; color:#10b981; }
        .badge-failed { background:#fef2f2; color:#ef4444; }
        .stage-desc { font-size:13px; color:#6b7280; margin:6px 0 0; line-height:1.6; }
        .streaming { margin-top:8px; font-size:12px; color:#3b82f6; }
        .stage-summary { margin-top:10px; }
        .summary-row { display:flex; gap:16px; font-size:13px; color:#6b7280; flex-wrap:wrap; }
        .summary-row b { color:#1a1a2e; }
        .warn { margin-top:6px; font-size:12px; color:#f59e0b; }
        .err-box { margin-top:8px; font-size:12px; color:#ef4444; background:#fef2f2; border:1px solid #fca5a5; border-radius:6px; padding:8px 10px; word-break:break-all; }
        .preview { flex:1; overflow-y:auto; padding:16px 18px; }
        .placeholder { color:#9ca3af; font-size:13px; line-height:1.7; }
        .raw { font-family:'SF Mono', monospace; font-size:12px; white-space:pre-wrap; word-break:break-all; color:#374151; margin:0; line-height:1.6; }
        .prd section { margin-bottom:18px; }
        .prd h4 { margin:0 0 8px; font-size:13px; font-weight:600; color:#1a1a2e; }
        .prd p { margin:0; font-size:13px; line-height:1.7; color:#374151; }
        .tags { display:flex; flex-wrap:wrap; gap:6px; }
        .tag { font-size:12px; padding:3px 8px; background:#f0f1f3; border-radius:6px; color:#6b7280; }
        .ftable { width:100%; border-collapse:collapse; font-size:12px; }
        .ftable th, .ftable td { border:1px solid #e5e7eb; padding:6px 8px; text-align:left; }
        .ftable th { background:#f7f8fa; font-weight:600; }
        .prio { display:inline-block; padding:1px 6px; border:1px solid; border-radius:4px; font-size:11px; font-weight:600; }
        .prd ul { margin:0; padding-left:18px; }
        .prd li { font-size:13px; line-height:1.7; color:#374151; }
        .prd code { font-family:'SF Mono', monospace; font-size:12px; color:#6b7280; }
        .assume { color:#92400e; }
      `}</style>
    </div>
  );
}
