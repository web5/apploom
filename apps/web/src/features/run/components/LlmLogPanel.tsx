import type { LlmLogEntry } from '@apploom/shared';

/** LLM 调试日志面板：展示该阶段每次 LLM 调用的 user prompt（含 repair 反馈）与响应 */
export function LlmLogPanel({ logs }: { logs: LlmLogEntry[] }) {
  return (
    <div className="llm-log-panel">
      {logs.map((log, i) => (
        <div key={i} className="llm-log-entry">
          <div className="llm-log-head">
            <span className="llm-log-label">{log.label}</span>
            <span className="llm-log-ts">{new Date(log.ts).toLocaleTimeString()}</span>
          </div>
          <div className="llm-log-section">
            <div className="llm-log-title">→ user（请求）</div>
            <pre className="llm-log-pre">{log.user}</pre>
          </div>
          <div className="llm-log-section">
            <div className="llm-log-title">← response（响应）</div>
            <pre className="llm-log-pre">{log.response}</pre>
          </div>
        </div>
      ))}
    </div>
  );
}
