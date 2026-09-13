import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

// stdout is a private readiness pipe to the native parent, never an application log.
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
console.log = (...args) => console.error(...args);
const input = createInterface({ input: process.stdin });
const config = JSON.parse((await once(input, 'line'))[0]);
if (config.type !== 'start' || typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir))
  throw new Error('Invalid desktop startup configuration');
let parentClosed = false;
input.on('close', () => { parentClosed = true; });
process.env.ROOST_DATA_DIR = config.dataDir;
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.ROOST_AUTH_INSECURE_HTTP = '1';
delete process.env.ROOST_ALLOWED_ORIGINS;

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const { startBackend } = await import('../../backend/src/index.js');
const token = randomBytes(32).toString('base64url');
const { server, stop } = await startBackend({ auth: { desktopSession: token, secureCookie: false } });
let stopping = false;
const shutdown = () => { if (stopping) return; stopping = true; stop(); input.close(); process.exit(0); };
input.on('line', line => { if (line === 'shutdown') shutdown(); });
input.on('close', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
if (parentClosed) shutdown();
if (!server.listening) await once(server, 'listening');
const address = `http://127.0.0.1:${server.address().port}`;
const publicRoot = fileURLToPath(new URL('frontend/dist/', root));
const assets = new Map();
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml',
  png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2', wasm: 'application/wasm', json: 'application/json' };
async function inventory(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await inventory(join(dir, entry.name), name + '/');
    else if (entry.isFile()) assets.set('/' + name, join(dir, entry.name));
  }
}
await inventory(publicRoot);
const index = (await readFile(join(publicRoot, 'index.html'), 'utf8')).replace('</head>',
  '<meta name="roost-runtime" content="desktop"></head>');
const handlers = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (req.url?.startsWith('/api/') || req.url === '/api') {
    for (const handle of handlers) handle.call(server, req, res);
    return;
  }
  if (req.headers.host !== new URL(address).host || (req.headers.origin && req.headers.origin !== address)) {
    res.writeHead(403).end(); return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  const path = new URL(req.url, address).pathname;
  const file = assets.get(path === '/' ? '/index.html' : path);
  if (!file) { res.writeHead(404).end(); return; }
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' " + address.replace('http:', 'ws:') + "; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  res.setHeader('content-type', types[file.split('.').at(-1)] ?? 'application/octet-stream');
  if (req.method === 'HEAD') { res.end(); return; }
  if (path === '/' || path === '/index.html') { res.end(index); return; }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});

// The private pipe carries a process-scoped session, not a user password.
const cookie = `roost_session=${token}; Path=/; HttpOnly; SameSite=Strict`;
send({ type: 'ready', url: address, cookie, pid: process.pid, buildId: manifest.buildId });
