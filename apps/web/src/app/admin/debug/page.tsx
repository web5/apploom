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
  const [followUp, setFollowUp] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [raw, setRaw] = useState('');
  const [prd, setPrd] = useState<PRD | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  async function send(appendFollowUp: boolean) {
    if (!requirement.trim() || status === 'running') return;
    setStatus('running');
    setRaw('');
    setPrd(null);
    setSummary(null);
    setError('');
    const ac = new AbortController();
    abortRef.current = ac;
    const finalRequirement = appendFollowUp && followUp.trim()
      ? `${requirement}\n\n补充指令：${followUp.trim()}`
      : requirement;
    try {
      const res = await fetch('/api/prd/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirement: finalRequirement }),
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

  async function copyPrdJson() {
    if (!prd) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(prd, null, 2));
      setError('');
      // 简单反馈：用 error 字段反向用作临时提示有点脏，这里用一个独立的小状态更干净
      // 为了零额外状态，用一次临时 setStatus 不合适；用 prompt() 也不合适——直接写一个本地变量
      // 改为：用 alert 太重。最简：在按钮上临时改 label。
      const btn = document.activeElement as HTMLButtonElement | null;
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ 已复制';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      }
    } catch {
      setError('复制失败：浏览器未授予剪贴板权限');
    }
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
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(true);
            }}
          />
          <div className="shortcuts">
            {['做一个团队待办应用', '做一个番茄钟', '做一个记账小程序'].map((s) => (
              <button key={s} className="chip" onClick={() => setRequirement(s)}>
                {s}
              </button>
            ))}
          </div>
          <label className="follow-label">补充指令（可选，会拼到需求后）</label>
          <textarea
            className="req-input follow-input"
            placeholder='例如："减少 P0 到 3 个" / "只做 Web 端，暂不做小程序"'
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
          />
        </div>
        <footer className="send-bar">
          {status === 'running' ? (
            <button className="btn btn-stop" onClick={stop}>
              停止
            </button>
          ) : (
            <>
              <button
                className="btn btn-send"
                onClick={() => send(true)}
                disabled={!requirement.trim()}
                title={followUp.trim() ? '会把补充指令拼到需求后' : ''}
              >
                {status === 'idle' ? '生成 PRD →' : '重新生成（带修改）→'}
              </button>
              {status === 'done' && (
                <button
                  className="btn btn-rerun"
                  onClick={() => send(false)}
                  disabled={!requirement.trim()}
                  title="忽略补充指令，用原始输入再跑一次（测提示词稳定性）"
                >
                  🔄 纯重跑
                </button>
              )}
            </>
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
              {(status === 'done' || status === 'error') && !summary && raw && (
                <div className="streaming">本次输出未通过 Zod 校验，查看右侧原始输出。</div>
              )}
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
              {(status === 'done' || status === 'error') && (
                <div className="stage-actions">
                  <button className="btn btn-rerun-sm" onClick={() => send(true)}>
                    {followUp.trim() ? '按修改重生成' : '🔄 重新生成'}
                  </button>
                  <button className="btn btn-rerun-sm" onClick={() => send(false)} title="忽略补充指令，原输入再跑（测稳定性）">
                    🔄 纯重跑
                  </button>
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
          <span className="ws-sub">
            {prd ? (
              <button className="btn btn-copy" onClick={copyPrdJson}>📋 复制 JSON</button>
            ) : (
              <span>{status === 'running' ? '流式原始输出' : '待生成'}</span>
            )}
          </span>
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
    </div>
  );
}
