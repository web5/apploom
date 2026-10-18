/**
 * Studio 页面样式。原样来自重构前页面里的内联 <style>，仍以内联方式注入（不改成全局 CSS 文件，避免改变层叠顺序与特异性）。
 */
export const STUDIO_CSS = `
.page { height:100vh; display:flex; flex-direction:column; background:#f7f8fa; color:#1a1a2e; font-family:-apple-system,'PingFang SC',sans-serif; }
.topbar { display:flex; align-items:center; justify-content:space-between; padding:12px 24px; background:#fff; border-bottom:1px solid #e5e7eb; }
.logo { font-weight:700; font-size:15px; }
.sub { font-size:12px; color:#9ca3af; flex:1; }
.history-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.35); display:flex; align-items:flex-start; justify-content:center; padding-top:80px; z-index:200; }
.history-panel { width:560px; max-height:70vh; background:#fff; border-radius:14px; box-shadow:0 12px 40px rgba(0,0,0,0.2); display:flex; flex-direction:column; overflow:hidden; }
.history-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #e5e7eb; font-size:14px; font-weight:600; }
.history-list { flex:1; overflow-y:auto; padding:8px; }
.history-item { padding:12px 14px; border-radius:10px; cursor:pointer; border:1px solid transparent; }
.history-item:hover { background:#f8fafc; border-color:#e2e8f0; }
.history-item-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.history-req { font-size:13px; font-weight:600; color:#1a1a2e; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.history-item-meta { display:flex; align-items:center; justify-content:space-between; margin-top:8px; font-size:11px; color:#9ca3af; }
.history-steps { display:flex; gap:4px; }
.dot { width:8px; height:8px; border-radius:50%; background:#e5e7eb; display:inline-block; }
.dot-done { background:#10b981; }
.dot-running { background:#3b82f6; }
.dot-error { background:#ef4444; }
.dot-waiting_confirm { background:#f59e0b; }
.layout { flex:1; display:flex; overflow:hidden; }
.main { flex:1; overflow-y:auto; padding:24px; display:flex; flex-direction:column; gap:16px; max-width:680px; }
.input-card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:10px; }
.lbl { font-size:12px; color:#6b7280; font-weight:600; }
.ta { width:100%; min-height:80px; resize:vertical; padding:10px 12px; border:1px solid #e5e7eb; border-radius:8px; font-size:14px; line-height:1.6; font-family:inherit; box-sizing:border-box; }
.ta:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px #eff6ff; }
.row { display:flex; gap:8px; align-items:center; }
.btn { border:none; border-radius:8px; padding:8px 16px; font-size:13px; cursor:pointer; font-weight:500; }
.btn-primary { background:#3b82f6; color:#fff; }
.btn-primary:hover { background:#2563eb; }
.btn-primary:disabled { background:#d1d5db; cursor:not-allowed; }
.btn-confirm { background:#f59e0b; color:#fff; }
.btn-confirm:hover { background:#d97706; }
.btn-confirm:disabled { background:#d1d5db; cursor:not-allowed; }
.btn-retry { background:#ef4444; color:#fff; }
.btn-retry:hover { background:#dc2626; }
.btn-retry:disabled { background:#d1d5db; cursor:not-allowed; }
.btn-ai-fix { background:#10b981; color:#fff; }
.btn-ai-fix:hover { background:#059669; }
.btn-ai-fix:disabled { background:#d1d5db; cursor:not-allowed; }
.btn-edit { background:#f0f1f3; color:#6b7280; }
.btn-edit:hover { background:#e5e7eb; }
.btn-ghost { background:transparent; color:#6b7280; border:1px solid #e5e7eb; }
.btn-ghost:hover { background:#f0f1f3; }
.confirm-toggle { margin-left:8px; font-size:12px; color:#6b7280; display:flex; align-items:center; gap:6px; cursor:pointer; }
.confirm-toggle input { accent-color:#3b82f6; }

.banner { padding:14px 24px; color:#fff; font-size:15px; font-weight:600; text-align:center; display:flex; align-items:center; justify-content:center; gap:12px; box-shadow:0 2px 8px rgba(0,0,0,0.12); position:sticky; top:0; z-index:100; }
.banner-run { background:linear-gradient(90deg,#3b82f6,#2563eb); }
.banner-wait { background:linear-gradient(90deg,#f59e0b,#d97706); }
.banner-fail { background:linear-gradient(90deg,#ef4444,#dc2626); }
.banner-done { background:linear-gradient(90deg,#10b981,#059669); }
.banner-spin { width:18px; height:18px; border:3px solid rgba(255,255,255,0.4); border-top-color:#fff; border-radius:50%; display:inline-block; flex-shrink:0; animation:studio-spin 0.8s linear infinite; }
.banner-btn { padding:6px 14px; border:1px solid rgba(255,255,255,0.5); background:rgba(255,255,255,0.15); border-radius:8px; color:#fff; font-size:13px; cursor:pointer; font-weight:600; }
.banner-btn:hover { background:rgba(255,255,255,0.3); }
.banner-btn:disabled { opacity:0.6; cursor:not-allowed; }
.banner-btn-confirm { background:#fff; color:#d97706; border-color:#fff; }
.banner-btn-confirm:hover { background:#fef3c7; }
.banner-btn-retry { background:#fff; color:#dc2626; border-color:#fff; }
.banner-btn-retry:hover { background:#fef2f2; }

.run-hint { margin-top:12px; padding:12px 14px; background:#eff6ff; border:2px solid #3b82f6; border-radius:10px; font-size:13px; color:#1e40af; display:flex; align-items:center; gap:10px; font-weight:500; }
.run-hint .banner-spin { width:16px; height:16px; border-width:2px; }
.wait-hint { background:#fffbeb; border-color:#f59e0b; color:#92400e; }
.raw-banner { margin-bottom:12px; padding:10px 12px; background:#eff6ff; border-radius:8px; border:1px solid #bfdbfe; font-size:12px; color:#3b82f6; display:flex; align-items:center; gap:8px; }
.raw-banner .banner-spin { width:14px; height:14px; border-width:2px; }

.pipeline { display:flex; flex-direction:column; align-items:stretch; }
.stage { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px 16px; }
.stage-pending { opacity:0.6; }
.stage-running { border-color:#3b82f6; box-shadow:0 0 0 3px #eff6ff; }
.stage-done { border-color:#10b981; }
.stage-error { border-color:#ef4444; }
.stage-waiting_confirm { border-color:#f59e0b; box-shadow:0 0 0 3px #fef3c7; }
.stage-head { display:flex; align-items:center; gap:10px; }
.stage-num { width:24px; height:24px; border-radius:50%; background:#f0f1f3; color:#6b7280; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
.stage-running .stage-num { background:#3b82f6; color:#fff; animation:studio-spin 1.2s linear infinite; }
.stage-done .stage-num { background:#10b981; color:#fff; }
.stage-error .stage-num { background:#ef4444; color:#fff; }
.stage-waiting_confirm .stage-num { background:#f59e0b; color:#fff; }
.stage-title { font-weight:600; font-size:14px; flex:1; }
.badge { font-size:11px; padding:2px 8px; border-radius:999px; }
.badge-pending { background:#f0f1f3; color:#6b7280; }
.badge-running { background:#eff6ff; color:#3b82f6; }
.badge-done { background:#ecfdf5; color:#10b981; }
.badge-error { background:#fef2f2; color:#ef4444; }
.badge-waiting_confirm { background:#fef3c7; color:#f59e0b; }
.stage-body { margin-top:10px; display:flex; flex-direction:column; gap:10px; }
.confirm-box { display:flex; align-items:center; justify-content:space-between; gap:10px; background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; padding:10px 12px; font-size:12px; color:#92400e; }
.fail-box { background:#fef2f2; border-color:#fca5a5; color:#991b1b; }
.fail-text { display:flex; flex-direction:column; gap:6px; flex:1; min-width:0; word-break:break-word; white-space:pre-wrap; }
.fail-class { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; font-size:11px; color:#7f1d1d; white-space:normal; }
.fail-class b { flex:none; white-space:nowrap; }
.fail-class i { font-style:normal; opacity:.85; flex:1 1 160px; min-width:0; }
.fail-box .row { flex:none; }
.fail-box .btn { white-space:nowrap; }
.stage-actions { display:flex; justify-content:flex-end; }
.repair-box { display:flex; flex-direction:column; gap:8px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px; }
.repair-ta { min-height:64px; font-size:13px; }
.btn-log { background:#f0f1f3; color:#6b7280; padding:4px 10px; font-size:11px; margin-left:auto; }
.btn-log:hover { background:#e5e7eb; }
.llm-log-panel { display:flex; flex-direction:column; gap:10px; margin-top:10px; }
.llm-log-entry { border:1px solid #e5e7eb; border-radius:8px; padding:10px; background:#fafafa; }
.llm-log-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.llm-log-label { font-size:11px; font-weight:700; color:#6d28d9; background:#ede9fe; padding:2px 8px; border-radius:999px; }
.llm-log-ts { font-size:10px; color:#9ca3af; }
.llm-log-section { margin-top:6px; }
.llm-log-title { font-size:11px; color:#6b7280; font-weight:600; margin-bottom:4px; }
.llm-log-pre { font-family:'SF Mono',monospace; font-size:10px; line-height:1.5; white-space:pre-wrap; word-break:break-all; color:#374151; background:#fff; border:1px solid #e5e7eb; border-radius:6px; padding:6px 8px; margin:0; max-height:200px; overflow-y:auto; }
.meta-row { display:flex; gap:16px; font-size:12px; color:#6b7280; }
.meta-row .ok { color:#10b981; font-weight:600; }
.meta-row .fail { color:#ef4444; font-weight:600; }
.techstack { display:flex; flex-wrap:wrap; gap:6px; }
.tk { font-size:11px; padding:3px 8px; background:#eff6ff; color:#3b82f6; border-radius:6px; border:1px solid #93c5fd; }
.connector { width:2px; height:20px; background:#e5e7eb; margin-left:24px; align-self:flex-start; }
.err { font-size:12px; color:#ef4444; background:#fef2f2; border:1px solid #fca5a5; border-radius:8px; padding:10px 12px; }

.preview { width:400px; background:#fff; border-left:1px solid #e5e7eb; display:flex; flex-direction:column; flex-shrink:0; }
.pv-header { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-bottom:1px solid #e5e7eb; font-size:14px; font-weight:600; }
.pv-sub { font-size:12px; color:#9ca3af; font-weight:400; }
.studio-pv-streaming { display:inline-flex; align-items:center; gap:6px; color:#3b82f6; }
.studio-dot-pulse { width:8px; height:8px; border-radius:50%; background:#3b82f6; display:inline-block; animation:studio-blink 1s step-end infinite; }
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

/* === 产品原型 HTML 预览 === */
.proto-frame { width:100%; height:480px; border:1px solid #e5e7eb; border-radius:10px; background:#fff; }
.flow-item { padding:8px 10px; border:1px solid #e5e7eb; border-radius:8px; margin-bottom:8px; }
.flow-item b { font-size:12px; color:#1a1a2e; }
.flow-desc { font-size:11px; color:#6b7280; margin-left:8px; }

@keyframes studio-spin { to { transform:rotate(360deg); } }
@keyframes studio-blink { 0%,50% { opacity:1; } 51%,100% { opacity:0; } }
`;
