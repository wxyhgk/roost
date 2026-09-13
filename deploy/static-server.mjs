// 生产入口（容器内）：serve frontend/dist，/api 反代到 backend（含 WS），并托管 backend 子进程。
// 零依赖，只用 node 内置模块。backend 退出则本进程同码退出，靠容器重启策略拉起。
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BACKEND_HOST = process.env.BACKEND_HOST ?? '127.0.0.1';
const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 8787);
const LISTEN_HOST = process.env.STATIC_HOST ?? '0.0.0.0';
const LISTEN_PORT = Number(process.env.STATIC_PORT ?? 8080);
const ROOT = new URL('../', import.meta.url);
const DIST = new URL('../frontend/dist/', import.meta.url);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);

function pickHeaders(incoming) {
  const out = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` };
  delete headers.connection;
  const upstream = httpRequest({
    host: BACKEND_HOST, port: BACKEND_PORT, path: req.url, method: req.method, headers,
  }, (reply) => {
    reply.on('error', () => res.destroy());
    res.on('error', () => reply.destroy());
    res.writeHead(reply.statusCode ?? 502, pickHeaders(reply.headers));
    reply.pipe(res);
  });
  upstream.setTimeout(30000, () => upstream.destroy(Error('backend timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('后端暂不可用，请重试');
  });
  req.on('error', () => upstream.destroy());
  res.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') pathname = '/index.html';
  // 无扩展名走 SPA fallback，有扩展名走文件
  if (!extname(pathname)) pathname = '/index.html';
  const file = normalize(pathname).replace(/^\.\.[\\/]/, '');
  const url = new URL(`.${file.startsWith(sep) ? file : sep + file}`, DIST);
  const body = await readFile(url).catch(() => null);
  if (!body) {
    // 兜底 index.html，仍没有则 404
    if (pathname !== '/index.html') {
      const fallback = await readFile(new URL('./index.html', DIST)).catch(() => null);
      if (fallback) {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : fallback);
        return;
      }
    }
    res.writeHead(404).end('not found');
    return;
  }
  const type = MIME[extname(pathname).toLowerCase()] ?? 'application/octet-stream';
  const cache = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = createServer((req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    proxyHttp(req, res);
    return;
  }
  void serveStatic(req, res);
});

// WS upgrade 只接 /api 前缀，原样透传 upgrade 握手
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname !== '/api' && !pathname.startsWith('/api/')) {
    socket.destroy();
    return;
  }
  const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}`, connection: 'Upgrade' };
  const upstream = httpRequest({
    host: BACKEND_HOST, port: BACKEND_PORT, path: req.url, method: 'GET', headers,
  });
  upstream.on('error', () => socket.destroy());
  // 后端拒绝握手（403/404/503）时直接断开，不让浏览器空等超时
  upstream.on('response', (ures) => {
    ures.resume();
    socket.end(`HTTP/1.1 ${ures.statusCode ?? 502} ${ures.statusMessage ?? 'rejected'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  });
  upstream.on('upgrade', (ures, usock, uhead) => {
    const fail = () => { usock.destroy(); socket.destroy(); };
    usock.on('error', fail);
    socket.on('error', fail);
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    if (ures.headers.upgrade) lines.push(`Upgrade: ${ures.headers.upgrade}`);
    if (ures.headers.connection) lines.push(`Connection: ${ures.headers.connection}`);
    if (ures.headers['sec-websocket-accept']) lines.push(`Sec-WebSocket-Accept: ${ures.headers['sec-websocket-accept']}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) usock.write(head);
    if (uhead?.length) socket.write(uhead);
    usock.pipe(socket);
    socket.pipe(usock);
  });
  upstream.end();
});

// 先起 backend，它的日志直接透出，方便查看。
// 默认 npm 启动；宿主机无 npm 时设 BACKEND_LAUNCH=tsx，直接用 node 跑 tsx。
const backend = process.env.BACKEND_LAUNCH === 'tsx'
  ? spawn(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), 'src/index.ts'], {
    cwd: fileURLToPath(new URL('../backend/', import.meta.url)),
    stdio: 'inherit',
    env: process.env,
  })
  : spawn('npm', ['run', 'start', '--prefix', 'backend'], {
    cwd: new URL(ROOT),
    stdio: 'inherit',
    env: process.env,
  });
backend.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
const forward = (signal) => backend.kill(signal);
process.once('SIGTERM', forward);
process.once('SIGINT', forward);

server.on('clientError', (_err, socket) => socket.destroy());
// 无 supervisor 的宿主机直跑：未知 socket 错误只记日志，不让整个服务退出
process.on('uncaughtException', (error) => console.error('static-server survived:', error));
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`static http://${LISTEN_HOST}:${LISTEN_PORT} -> backend ${BACKEND_HOST}:${BACKEND_PORT}`);
});
