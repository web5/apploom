import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { createPipelineDoc, type PipelineDoc } from '../pipeline/pipeline.types';
import { createPreviewHandlers, parsePreviewHost, portOfLocalUrl, previewConfig, previewPort, previewUrl } from './preview-proxy';

const cfg = { baseDomain: 'preview.localhost:3001', scheme: 'http' as const };
const ID = '4eaffc62-0c90-4cdf-8a91-c7955d4f6f6c';

const deployed = (port: number | undefined, status = 'success', stageStatus: 'done' | 'failed' = 'done'): PipelineDoc => {
  const d = createPipelineDoc('x', false);
  d.stages.deploy.status = stageStatus;
  d.stages.deploy.result = { status, port, url: `http://localhost:${port}` };
  return d;
};

describe('预览域名与端口解析', () => {
  it('配置：未设置 = 关闭；格式不对直接报错', () => {
    expect(previewConfig({})).toBeNull();
    expect(previewConfig({ PREVIEW_BASE_DOMAIN: 'Preview.localhost:3001' })).toEqual(cfg);
    expect(previewConfig({ PREVIEW_BASE_DOMAIN: 'p.example.com', PREVIEW_SCHEME: 'https' })).toEqual({ baseDomain: 'p.example.com', scheme: 'https' });
    expect(() => previewConfig({ PREVIEW_BASE_DOMAIN: 'bad host/x' })).toThrow(/PREVIEW_BASE_DOMAIN/);
  });

  it('只认 <uuid>.<baseDomain>：别的域名、非 uuid、带路径字符都不匹配', () => {
    expect(previewUrl(ID, cfg)).toBe(`http://${ID}.preview.localhost:3001/`);
    expect(parsePreviewHost(`${ID}.preview.localhost:3001`, cfg)).toBe(ID);
    expect(parsePreviewHost(`${ID.toUpperCase()}.PREVIEW.localhost:3001`, cfg)).toBe(ID);
    for (const h of ['localhost:3001', `${ID}.other.localhost:3001`, 'abc.preview.localhost:3001', `x.${ID}.preview.localhost:3001`, undefined, `${ID}.preview.localhost`]) {
      expect(parsePreviewHost(h, cfg)).toBeNull();
    }
  });

  it('目标端口：必须是部署成功的 ≥1024 端口，且不能是基础设施端口（防 SSRF）', () => {
    const deny = [6379, 3001, 5432];
    expect(previewPort(deployed(5173), deny)).toBe(5173);
    expect(previewPort(deployed(5173, 'failed'), deny)).toBeNull();
    expect(previewPort(deployed(5173, 'success', 'failed'), deny)).toBeNull();
    for (const p of [undefined, 80, 22, 6379, 3001, 5432, 70000, 5173.5]) expect(previewPort(deployed(p as number), deny)).toBeNull();
    expect(previewPort(null, deny)).toBeNull();
  });

  it('从 dev server 的 URL 取端口：只接受 localhost / 127.0.0.1', () => {
    expect(portOfLocalUrl('http://localhost:5173')).toBe(5173);
    expect(portOfLocalUrl('http://127.0.0.1:4100/')).toBe(4100);
    expect(portOfLocalUrl('http://evil.com:5173')).toBeNull();
    expect(portOfLocalUrl('nonsense')).toBeNull();
  });
});

describe('反向代理（真实 HTTP / WebSocket 转发）', () => {
  let upstream: Server;
  let proxy: Server;
  let proxyPort = 0;
  let upstreamPort = 0;
  const docs = new Map<string, PipelineDoc>();
  const sockets = new Set<import('node:net').Socket>();
  const track = (srv: Server) => srv.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-seen-host': String(req.headers.host) });
        res.end(`${req.method} ${req.url} body=${body}`);
      });
    });
    upstream.on('upgrade', (req, socket) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-seen-origin: ${req.headers.origin}\r\n\r\n`);
      socket.on('data', (d) => socket.write(`echo:${d}`));
    });
    track(upstream);
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream.address() as AddressInfo).port;
    docs.set(ID, deployed(upstreamPort));

    const handlers = createPreviewHandlers(cfg, async (id) => docs.get(id) ?? null);
    proxy = createServer((req, res) => handlers.middleware(req, res, () => { res.writeHead(200); res.end('api-route'); }));
    proxy.on('upgrade', handlers.upgrade);
    track(proxy);
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });
  afterAll(() => {
    upstream.close();
    proxy.close();
    for (const c of sockets) c.destroy();
  });

  const get = (host: string, path = '/', method = 'GET', body = '') =>
    new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxyPort, path, method, headers: { host } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(body);
    });

  it('预览域名的请求转发到 dev server（路径 / 方法 / 请求体原样，Host 改写成 localhost:端口）', async () => {
    const r = await get(`${ID}.${cfg.baseDomain}`, '/src/main.tsx?x=1', 'POST', 'hello');
    expect(r.status).toBe(200);
    expect(r.text).toBe('POST /src/main.tsx?x=1 body=hello');
    expect(r.headers['x-seen-host']).toBe(`localhost:${upstreamPort}`);
  });

  it('其它域名不拦截（走正常路由）；未部署 / 不存在的预览 404；上游挂了 502', async () => {
    expect((await get('localhost:3001')).text).toBe('api-route');
    const other = '11111111-2222-3333-4444-555555555555';
    expect((await get(`${other}.${cfg.baseDomain}`)).status).toBe(404);
    docs.set(other, createPipelineDoc('x', false));
    expect((await get(`${other}.${cfg.baseDomain}`)).status).toBe(404);
    const dead = '22222222-2222-3333-4444-555555555555';
    docs.set(dead, deployed(1)); // 1 < 1024：被拒
    expect((await get(`${dead}.${cfg.baseDomain}`)).status).toBe(404);
    const gone = '33333333-2222-3333-4444-555555555555';
    const free = await new Promise<number>((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
    docs.set(gone, deployed(free));
    expect((await get(`${gone}.${cfg.baseDomain}`)).status).toBe(502);
  });

  it('WebSocket 升级：握手与后续数据双向转发，Origin 改写成 localhost:端口', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      const sock = connect(proxyPort, '127.0.0.1', () => {
        sock.write(`GET /hmr HTTP/1.1\r\nHost: ${ID}.${cfg.baseDomain}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: http://evil.example\r\nSec-WebSocket-Key: x\r\n\r\n`);
      });
      let got = '';
      sock.on('data', (d) => {
        got += d;
        if (got.includes('\r\n\r\n') && !got.includes('echo:')) sock.write('ping');
        if (got.includes('echo:ping')) { sock.destroy(); resolve(got); }
      });
      sock.on('error', reject);
      const timer = setTimeout(() => reject(new Error(`超时: ${got}`)), 3000);
      sock.on('close', () => clearTimeout(timer));
    });
    expect(out).toContain('101 Switching Protocols');
    expect(out.toLowerCase()).toContain(`x-seen-origin: http://localhost:${upstreamPort}`);
    expect(out).toContain('echo:ping');
  });
});
