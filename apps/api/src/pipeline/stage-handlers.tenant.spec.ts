import { createPipelineDoc } from './pipeline.types';
import { createStageRunner } from './stage-handlers';

const codegen = { files: [{ path: 'package.json', content: '{}' }], dependencies: [], runCommand: 'npm run dev', notes: [] };

function setup(ownerId?: string) {
  const doc = createPipelineDoc('x', false);
  doc.id = 'd1';
  if (ownerId) doc.ownerId = ownerId;
  doc.stages.prototype.result = { html: '<div/>', pages: [], interactions: [] };
  doc.stages.design.result = {};
  doc.stages.codegen.result = codegen;
  const deps = {
    agents: { run: jest.fn(async (stage: string) => ({ raw: '', doc: stage === 'deploy' ? { target: 'local', url: '', repoUrl: '', buildLog: '', status: 'success', port: 5173 } : codegen, summary: {} })) },
    gate: { verify: jest.fn(async () => ({ passed: true, failures: [], checks: [] })) },
    deploy: { deploy: jest.fn(async () => ({ url: 'http://localhost:5173', buildLog: '', status: 'success' as const })) },
  };
  const run = createStageRunner(deps as never);
  const ctx = (stage: 'codegen' | 'deploy') => ({ docId: 'd1', doc, stage, onToken: () => undefined, logs: [], guard: () => undefined });
  return { deps, run, ctx };
}

describe('阶段处理器把流水线归属作为租户传给沙箱', () => {
  it('有 ownerId：门禁与部署都带上；没有则保持原来的调用形态（不多传参数）', async () => {
    const owned = setup('alice');
    await owned.run(owned.ctx('codegen'));
    await owned.run(owned.ctx('deploy'));
    expect(owned.deps.gate.verify).toHaveBeenCalledWith('d1', codegen, expect.any(Function), 'alice');
    expect(owned.deps.deploy.deploy).toHaveBeenCalledWith('d1', codegen, expect.any(Function), 'alice');

    const anon = setup();
    await anon.run(anon.ctx('codegen'));
    await anon.run(anon.ctx('deploy'));
    expect(anon.deps.gate.verify).toHaveBeenCalledWith('d1', codegen, expect.any(Function));
    expect(anon.deps.deploy.deploy).toHaveBeenCalledWith('d1', codegen, expect.any(Function));
  });
});
