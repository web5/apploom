import type { StageId } from '@apploom/shared/graph';

const STAGE_STEPS: Record<StageId, string[]> = {
  requirement: ['解析一句话需求', '识别目标用户与场景', '拆解功能与优先级', '抽取数据实体', '生成假设与验收点'],
  prototype: ['阅读 PRD 页面清单', '设计页面布局区块', '拆解组件与文案', '梳理核心用户流程', '定义交互跳转关系'],
  design: ['阅读 PRD 与原型', '决策技术栈', '设计页面路由', '设计数据模型', '设计 API 接口'],
  codegen: ['阅读 Design 与原型', '规划文件结构', '生成页面组件', '生成 API 路由', '生成配置与依赖'],
  deploy: ['阅读 Codegen', '准备构建环境', '安装依赖', '执行构建', '发布到云端'],
};

export function StageLoading({ stage, streaming }: { stage: StageId; streaming: string }) {
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
            const color = i < progress ? '#10b981' : i === progress ? '#3b82f6' : '#9ca3af';
            return (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color }}>
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
