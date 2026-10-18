import type { DeployDocument } from '@apploom/shared';

export function DeployView({ deploy }: { deploy: DeployDocument }) {
  return (
    <div>
      <section><h4>部署状态</h4>
        <p className={deploy.status === 'success' ? 'deploy-success' : 'deploy-failed'}>
          {deploy.status === 'success' ? '✓ 部署成功' : '✗ 部署失败'}
        </p>
      </section>
      <section><h4>部署目标</h4>
        <p>{deploy.target === 'local' ? '💻 本地真部署（dev server 已启动）' : deploy.target === 'cloud' ? '☁ 内置云托管' : '📦 Git 仓库导出'}</p>
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
