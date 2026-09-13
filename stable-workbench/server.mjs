import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const validName = name => /^(?:(?:assets|logos)\/)?[a-zA-Z0-9_.-]+$/.test(name) && !name.includes('..');
for (const [name, hash] of Object.entries(manifest.files)) {
  if (!validName(name)) throw Error('invalid release manifest');
  if (createHash('sha256').update(await readFile(new URL(name, root))).digest('hex') !== hash) throw Error(`release checksum mismatch: ${name}`);
}
if (process.argv.includes('--check')) console.log(JSON.stringify({ version: manifest.version, buildId: manifest.buildId, directory: fileURLToPath(root) }));
else {
  const host = process.env.WORKBENCH_HOST ?? '127.0.0.1', port = Number(process.env.WORKBENCH_PORT ?? 8789);
  const core = new URL(process.env.WORKBENCH_CORE_URL ?? 'http://127.0.0.1:8788');
  const business = new URL(process.env.WORKBENCH_BUSINESS_URL ?? 'http://127.0.0.1:8787');
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid loopback listener');
  for(const url of [core,business]) if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password) throw Error('invalid loopback service URL');
  const files = new Map();
  const types = { js:'text/javascript', css:'text/css', html:'text/html', svg:'image/svg+xml', png:'image/png', woff2:'font/woff2', wasm:'application/wasm', json:'application/json' };
  for (const name of Object.keys(manifest.files)) {
    if(name === 'server.mjs') continue;
    files.set(name === 'index.html' ? '/' : '/'+name, { body: await readFile(new URL(name, root)), type: types[name.split('.').at(-1)] ?? 'application/octet-stream' });
  }
  const ws = new URL(core.origin); ws.protocol = 'ws:';
  const server = createServer((req, res) => {
    const hosts = [`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`];
    if (!hosts.includes(req.headers.host)) { res.writeHead(403).end(); return; }
    if (req.headers.origin && !hosts.map(h=>'http://'+h).includes(req.headers.origin)) { res.writeHead(403).end(); return; }
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ${core.origin} ${ws.origin}; frame-src 'self' http://127.0.0.1:5173 http://localhost:5173; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`);
    const path = new URL(req.url, 'http://localhost').pathname;
    // Business features retain their existing API. Terminal HTTP/WS bypass this proxy entirely.
    if(path.startsWith('/api/') && !path.startsWith('/api/core/') && path !== '/api/pty') {
      const target = new URL(business.origin); target.pathname = path; target.search = new URL(req.url,'http://localhost').search;
      const headers = { ...req.headers, host: business.host, origin: business.origin };
      delete headers.connection;
      const upstream = request(target,{method:req.method,headers}, reply => {
        res.writeHead(reply.statusCode ?? 502, { 'content-type':reply.headers['content-type'] ?? 'application/json' }); reply.pipe(res);
      });
      upstream.setTimeout(30000,()=>upstream.destroy(Error('business backend timeout')));
      upstream.on('error',()=>{if(!res.headersSent) res.writeHead(503,{'content-type':'text/plain; charset=utf-8'}); res.end('业务服务暂不可用，请重试');});
      res.on('close',()=>upstream.destroy()); req.pipe(upstream); return;
    }
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    let item = files.get(path);
    if (path === '/config.json') item = { type: 'application/json', body: JSON.stringify({ version: `${manifest.version} · ${manifest.buildId}`, coreUrl: core.origin }) };
    if (path === '/healthz') item = { type: 'application/json', body: JSON.stringify({ ok: true, buildId: manifest.buildId }) };
    if (!item) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': item.type }); res.end(req.method === 'HEAD' ? undefined : item.body);
  });
  server.listen(port, host, () => console.log(`Stable workbench http://${host === '::1' ? '[::1]' : host}:${port} release=${manifest.buildId} core=${core.origin}`));
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
