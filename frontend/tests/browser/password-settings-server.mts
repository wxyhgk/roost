// Real auth and persistence in an isolated directory. No user credentials,
// workspace database or daemon are opened by this browser fixture.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer as httpServer } from 'node:http';
import { createServer as viteServer } from 'vite';
import { createAuthentication } from '../../../backend/src/auth.ts';
import { loadAuthentication } from '../../../backend/src/auth-config.ts';
const directory = await mkdtemp(join(tmpdir(), 'password-browser-'));
const config = await loadAuthentication(directory);
await config.savePassword!('browser fixture old password');
let auth = createAuthentication({ ...await loadAuthentication(directory), secureCookie: false });
let delayedExpiry: import('node:http').ServerResponse | null = null;
const server = httpServer(async (req, res) => {
  if (req.url === '/api/test-release-expiry' && req.method === 'POST') {
    delayedExpiry?.writeHead(401, { 'content-type': 'application/json' });
    delayedExpiry?.end(JSON.stringify({ error: { code: 'unauthorized', message: 'login required' } }));
    delayedExpiry = null; res.writeHead(200); res.end('{}'); return;
  }
  if (req.url === '/__test/restart-auth' && req.method === 'POST') {
    auth.dispose(); auth = createAuthentication({ ...await loadAuthentication(directory), secureCookie: false });
    res.writeHead(200); res.end('restarted'); return;
  }
  if (await auth.handle(req, res, new URL(req.url!, 'http://localhost'))) return;
  if (!auth.require(req, res)) return;
  if (req.url === '/api/test-delayed-expiry') {
    delayedExpiry = res;
    auth.dispose(); auth = createAuthentication({ ...await loadAuthentication(directory), secureCookie: false });
    return;
  }
  if (req.url === '/api/test-heartbeat') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const vite = await viteServer({ root: resolve('frontend'), configFile: resolve('frontend/vite.config.ts'), server: { host: '127.0.0.1', port: 5176, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true, ws: false } } } });
await vite.listen();
console.log(JSON.stringify({ page: 'http://127.0.0.1:5176/tests/browser/password-settings.html', fixtureBackend: `http://127.0.0.1:${port}` }));
async function stop() { await vite.close(); auth.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); process.exit(); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
