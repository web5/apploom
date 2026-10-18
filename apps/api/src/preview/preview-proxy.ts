/**
 * 预览反向代理：把部署出来的 dev server 通过 `http://<docId>.<PREVIEW_BASE_DOMAIN>/` 暴露，而不是让每个用户直连
 * 宿主机的随机端口（多用户 / 远程访问时 localhost:端口 对别人根本打不开，也无法统一鉴权与审计）。
 *
 * 用子域名而不是路径前缀：dev server（vite / next）的资源路径是根相对的（/src/main.tsx），挂在 /preview/xxx/ 下会全部 404。
 * 本机开发用 `preview.localhost:3001`（浏览器会把 *.localhost 解析到回环地址）；线上配通配域名即可。
 *
 * 访问控制：子域名里的 docId 是 UUID，不可猜测，作为「能力 URL」——知道链接才能访问，列表接口已按归属过滤，不会泄露他人的 docId。
 * SSRF 防护：上游永远是 localhost:<端口>（vite 等常只监听 ::1，所以不能写死 127.0.0.1），端口只取自部署阶段记录的结果（localhost 地址）、必须 ≥1024 且不是 Redis / 数据库 / API 自身。
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { PipelineDoc } from '../pipeline/pipeline.types';
import { infraPorts } from '../sandbox/sandbox';

export interface PreviewConfig {
  /** 预览根域名（可含端口），如 preview.localhost:3001 */
  baseDomain: string;
  scheme: 'http' | 'https';
}

export function previewConfig(env: NodeJS.ProcessEnv = process.env): PreviewConfig | null {
  const baseDomain = (env.PREVIEW_BASE_DOMAIN ?? '').trim().toLowerCase();
  if (!baseDomain) return null;
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(baseDomain)) throw new Error(`PREVIEW_BASE_DOMAIN 格式不对: ${JSON.stringify(env.PREVIEW_BASE_DOMAIN)}（示例 preview.localhost:3001）`);
  return { baseDomain, scheme: env.PREVIEW_SCHEME === 'https' ? 'https' : 'http' };
}

export function previewUrl(docId: string, cfg: PreviewConfig): string {
  return `${cfg.scheme}://${docId}.${cfg.baseDomain}/`;
}

const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 从 Host 头取出 docId；不是 `<uuid>.<baseDomain>` 就返回 null */
export function parsePreviewHost(host: string | undefined, cfg: PreviewConfig): string | null {
  if (!host) return null;
  const h = host.toLowerCase();
  const suffix = `.${cfg.baseDomain}`;
  if (!h.endsWith(suffix)) return null;
  const id = h.slice(0, -suffix.length);
  return DOC_ID.test(id) ? id : null;
}

/** 部署成功的预览所在端口；任何不符合预期的情况都返回 null（不代理） */
export function previewPort(doc: Pick<PipelineDoc, 'stages'> | null, deny: number[] = infraPorts()): number | null {
  const result = doc?.stages.deploy.result as { status?: string; port?: number } | undefined;
  const port = result?.port;
  if (doc?.stages.deploy.status !== 'done' || result?.status !== 'success') return null;
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535 || deny.includes(port as number)) return null;
  return port as number;
}

/** 从 dev server 打印的本地 URL 取端口 */
export function portOfLocalUrl(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    const p = Number(u.port);
    return p > 0 ? p : null;
  } catch {
    return null;
  }
}

export interface PreviewHandlers {
  middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

type GetDoc = (id: string) => Promise<PipelineDoc | null>;

const fail = (res: ServerResponse, code: number, message: string) => {
  if (res.headersSent) return void res.destroy();
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
};

export function createPreviewHandlers(cfg: PreviewConfig, getDoc: GetDoc): PreviewHandlers {
  /** 解析本次请求要代理到的端口；失败时返回给调用方的 HTTP 状态与原因 */
  const resolve = async (host: string | undefined): Promise<{ port: number } | { code: number; message: string } | null> => {
    const id = parsePreviewHost(host, cfg);
    if (!id) return null;
    const port = previewPort(await getDoc(id).catch(() => null));
    return port ? { port } : { code: 404, message: '预览不存在，或尚未部署成功' };
  };

  return {
    middleware(req, res, next) {
      if (!parsePreviewHost(req.headers.host, cfg)) return next();
      void resolve(req.headers.host).then((r) => {
        if (!r) return next();
        if ('code' in r) return fail(res, r.code, r.message);
        // Host 改写成 localhost:端口：vite 默认只放行 localhost，不改会被它的 Host 校验拒掉
        const up = httpRequest({ host: 'localhost', port: r.port, agent: false, method: req.method, path: req.url, headers: { ...req.headers, host: `localhost:${r.port}` } }, (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        });
        up.on('error', () => fail(res, 502, '预览服务没有响应（dev server 可能已退出，请重新部署）'));
        res.on('close', () => up.destroy());
        req.pipe(up);
      });
    },

    // WebSocket（vite / next 的热更新）：原样转发握手，之后双向管道
    upgrade(req, socket, head) {
      if (!parsePreviewHost(req.headers.host, cfg)) return; // 不是预览域名：留给别的 upgrade 处理者
      void resolve(req.headers.host).then((r) => {
        if (!r || 'code' in r) return void socket.destroy();
        const upstream = netConnect(r.port, 'localhost', () => {
          const headers: string[] = [];
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const k = req.rawHeaders[i];
            const lower = k.toLowerCase();
            const v = lower === 'host' ? `localhost:${r.port}` : lower === 'origin' ? `http://localhost:${r.port}` : req.rawHeaders[i + 1];
            headers.push(`${k}: ${v}`);
          }
          upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
          if (head.length > 0) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
      });
    },
  };
}
