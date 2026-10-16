/**
 * 沙箱集成测试：让「真实的门禁代码路径」（CodegenGateService → shell 工具 → npm install）去跑一个带恶意
 * postinstall 的项目，验证它在 install 里既写不出工作区、也读不到家目录 / 其它 doc / 环境变量里的密钥。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { CodegenGateService } from './codegen-gate';
import { SeatbeltExecutor } from '../sandbox/seatbelt';

const PROBE = `
const fs = require('fs');
const r = {};
const tryDo = (k, fn) => { try { r[k] = fn(); } catch (e) { r[k] = 'DENIED:' + e.code; } };
tryDo('writeOutside', () => { fs.writeFileSync(process.env.PROBE_OUTSIDE, 'pwned'); return 'WROTE'; });
tryDo('readHomeSecret', () => fs.readFileSync(process.env.PROBE_HOME_SECRET, 'utf8'));
tryDo('readOtherDoc', () => fs.readFileSync(process.env.PROBE_OTHER_DOC, 'utf8'));
r.envSecret = process.env.TEST_GATE_FAKE_SECRET_KEY ?? 'ABSENT';
r.home = process.env.HOME;
fs.writeFileSync('probe-result.json', JSON.stringify(r));
`;

const rnd = Math.random().toString(36).slice(2, 8);
const outside = `/tmp/apploom-gate-escape-${rnd}`;
const homeSecret = path.join(homedir(), `.apploom-gate-secret-${rnd}`);
const otherDocDir = `/tmp/apploom-gate/other-${rnd}`;
const otherDoc = path.join(otherDocDir, 'data.txt');

/** postinstall 脚本读不到 process.env 之外的参数，把探针需要的路径经 env 白名单之外的方式写进脚本 */
const probeScript = PROBE.replace(/process\.env\.PROBE_OUTSIDE/g, JSON.stringify(outside))
  .replace(/process\.env\.PROBE_HOME_SECRET/g, JSON.stringify(homeSecret))
  .replace(/process\.env\.PROBE_OTHER_DOC/g, JSON.stringify(otherDoc));

const codegen = {
  files: [
    { path: 'package.json', content: JSON.stringify({ name: 'probe', version: '1.0.0', private: true, scripts: { postinstall: 'node probe.js' } }) },
    { path: 'probe.js', content: probeScript },
    { path: 'index.html', content: '<!doctype html><html><body>probe</body></html>' },
  ],
  dependencies: [],
  runCommand: 'node probe.js',
};

const approvals = { approverFor: () => () => 'allowed-once' } as never;
const available = SeatbeltExecutor.isAvailable() ? describe : describe.skip;

available('门禁里的 npm install（真实路径）', () => {
  const saved = { ...process.env };
  const sbxHome = `/tmp/apploom-sbx-home-gate-${rnd}`;

  beforeAll(() => {
    mkdirSync(otherDocDir, { recursive: true });
    writeFileSync(otherDoc, 'OTHER-DOC-SECRET');
    writeFileSync(homeSecret, 'HOME-SECRET');
  });
  beforeEach(() => {
    process.env.TEST_GATE_FAKE_SECRET_KEY = 'leak-me';
    process.env.SANDBOX_HOME = sbxHome;
    rmSync(outside, { force: true });
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  afterAll(() => {
    for (const p of [outside, homeSecret, otherDocDir, sbxHome]) rmSync(p, { recursive: true, force: true });
  });

  async function runProbe(docId: string) {
    const report = await new CodegenGateService(approvals).verify(docId, codegen, () => undefined);
    const resultFile = `/tmp/apploom-gate/${docId}/probe-result.json`;
    const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf-8')) : undefined;
    rmSync(`/tmp/apploom-gate/${docId}`, { recursive: true, force: true });
    return { report, result };
  }

  it('对照（SANDBOX_MODE=off）：只有环境变量白名单——文件系统仍可越权，说明下面的断言有区分度', async () => {
    process.env.SANDBOX_MODE = 'off';
    const { result } = await runProbe(`ctrl-${rnd}`);
    expect(result.envSecret).toBe('ABSENT'); // 白名单始终生效
    expect(result.writeOutside).toBe('WROTE');
    expect(result.readHomeSecret).toBe('HOME-SECRET');
    expect(result.readOtherDoc).toBe('OTHER-DOC-SECRET');
    expect(existsSync(outside)).toBe(true);
  }, 120_000);

  it('启用 Seatbelt：postinstall 写不出工作区、读不到家目录 / 其它 doc / 环境密钥，门禁本身仍通过', async () => {
    process.env.SANDBOX_MODE = 'auto';
    const { report, result } = await runProbe(`sbx-${rnd}`);
    expect(report.passed).toBe(true);
    expect(result.writeOutside).toMatch(/^DENIED:/);
    expect(result.readHomeSecret).toMatch(/^DENIED:/);
    expect(result.readOtherDoc).toMatch(/^DENIED:/);
    expect(result.envSecret).toBe('ABSENT');
    expect(result.home).toBe(sbxHome);
    expect(existsSync(outside)).toBe(false);
  }, 120_000);
});
