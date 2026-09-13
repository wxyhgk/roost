import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerMonitorHandler } from '../src/server-monitor.ts';
import { createAuthentication } from '../src/auth.ts';
import { HttpInputError, sendError } from '../src/http.ts';
async function fixture(t: TestContext, directory?: string) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), 'monitor-route-'));
  let services: string[] = ['caddy.service'], disposed = false, samples = 0, summaries = 0;
  const handler = createServerMonitorHandler(dir, { configure(s) { services = s; }, async summary() { summaries++; return { host: { hostname: 'fixture' } } as never; }, async snapshot() { samples++; return { configuredServices: services } as never; }, dispose() { disposed = true; } });
  const password = 'isolated monitor test password';
  const auth = createAuthentication({ password, secureCookie: false });
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    if (await auth.handle(req, res, url) || !auth.require(req, res)) return;
    try { if (!await handler.handle(req, res, url)) { res.writeHead(404); res.end(); } }
    catch (e) { sendError(res, e instanceof HttpInputError ? e.status : 500, 'invalid_request', 'Invalid input'); }
  })(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); handler.dispose(); auth.dispose(); if (!directory) await rm(dir, { recursive: true, force: true }); });
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'PUT') => fetch(base + path, { method, headers: { cookie, origin: base, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { base, dir, request, samples: () => samples, summaries: () => summaries, disposed: () => disposed };
}
test('metrics and service writes require login and never sample for unauthenticated readers', async t => {
  const f = await fixture(t);
  for (const path of ['/api/server/status', '/api/server/summary', '/api/server/services']) assert.equal((await fetch(f.base + path)).status, 401);
  assert.equal(f.samples(), 0);
  const response = await f.request('/api/server/status'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(f.samples(), 1);
});
test('service configuration persists atomically and is restored by a new handler', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/server/services', { services: ['nginx', 'worker@one.service', 'nginx'] });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { services: ['nginx.service', 'worker@one.service'] });
  const path = join(f.dir, 'monitored-services.json'); assert.equal((await stat(path)).mode & 0o777, 0o600);
  const next = await fixture(t, f.dir);
  assert.deepEqual(await (await next.request('/api/server/status')).json(), { configuredServices: ['nginx.service', 'worker@one.service'] });
  await f.request('/api/server/services', { services: [] }); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
});
test('invalid unit names, oversized writes and unsupported methods cannot alter the saved list', async t => {
  const f = await fixture(t);
  await f.request('/api/server/services', { services: ['caddy'] });
  assert.equal((await f.request('/api/server/services', { services: ['caddy; reboot'] })).status, 400);
  assert.equal((await f.request('/api/server/services', { services: ['x'.repeat(9000)] })).status, 413);
  assert.equal((await f.request('/api/server/services', { services: ['caddy'] }, 'POST')).status, 405);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'monitored-services.json'), 'utf8')), ['caddy.service']);
});

test('summary reads do not trigger full sampling, use no-store and reject writes', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/server/summary');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).host.hostname, 'fixture');
  assert.equal(f.summaries(), 1); assert.equal(f.samples(), 0);
  const write = await f.request('/api/server/summary', {}, 'POST');
  assert.equal(write.status, 405); assert.equal(write.headers.get('allow'), 'GET');
});
