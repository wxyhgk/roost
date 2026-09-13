import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { latestPty, spawned } from './helpers/fake-pty.ts';
import { createAccessPolicy } from '../src/access.ts';
import type { IncomingMessage } from 'node:http';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-hardening-'));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
  const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { store, runtime, dir, port, base, sockets, request };
}

test('Origin and Host policy allows precise development origins and rejects ambiguous authority', () => {
  const policy = createAccessPolicy({ allowedOrigins: ['https://dev.example.test'] });
  const req = (host: string, origin?: string, extra = {}) => ({ headers: { host, ...(origin === undefined ? {} : { origin }), ...extra }, socket: { localPort: 8787 } }) as IncomingMessage;
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8787', 'https://dev.example.test', undefined]) {
    const decision = policy(req('127.0.0.1:8787', origin)); assert.equal(decision.allowed, true);
    assert.notEqual(decision.headers['access-control-allow-origin'], '*');
  }
  for (const origin of ['https://evil.test', 'null', 'http://localhost:9999', 'http://localhost:5173/path', 'http://localhost:5173, https://evil.test']) {
    assert.equal(policy(req('127.0.0.1:8787', origin)).allowed, false);
  }
  for (const host of ['evil.test:8787', 'localhost.evil.test:8787', 'localhost:9999', 'user@localhost:8787', 'localhost:8787/path', 'localhost:8787#evil']) {
    assert.equal(policy(req(host)).allowed, false);
  }
  assert.equal(policy(req('[::1]:8787')).allowed, true);
  assert.equal(policy(req('localhost:8787', undefined, { 'sec-fetch-site': 'cross-site' })).allowed, false);
  assert.throws(() => createAccessPolicy({ allowedOrigins: ['*'] }));
});

test('untrusted HTTP reads, writes and preflights are rejected before workspace or PTY mutation', async t => {
  const f = await fixture(t); const before = f.store.loadWorkspace(); const ptys = spawned.length;
  for (const [method, path, body] of [
    ['GET', '/api/workspace', undefined], ['GET', '/api/fs?root=/tmp', undefined],
    ['POST', '/api/sessions', { cwd: f.dir }], ['DELETE', '/api/projects/missing', undefined],
    ['OPTIONS', '/api/sessions', undefined],
  ] as const) {
    const response = await f.request(method, path, body, { origin: 'https://evil.test' });
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.deepEqual(f.store.loadWorkspace(), before); assert.equal(spawned.length, ptys);
  const trusted = await f.request('GET', '/api/workspace', undefined, { origin: 'http://localhost:5173' });
  assert.equal(trusted.status, 200); assert.equal(trusted.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal((await f.request('OPTIONS', '/api/sessions', undefined, { origin: 'http://localhost:5173' })).status, 204);
  assert.equal((await f.request('GET', '/api/health')).status, 200);
});

test('WebSocket Origin guard denies outsiders and permits the Vite frontend', async t => {
  const f = await fixture(t);
  f.store.upsertSession({ id: 's', cwd: f.dir }); f.runtime.ensureSession('s', f.dir);
  const url = f.base.replace('http', 'ws') + '/api/pty?id=s';
  const rejected = new WebSocket(url, { origin: 'https://evil.test' }); f.sockets.add(rejected);
  rejected.on('error', () => {});
  const response = await new Promise<number>(resolve => rejected.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode!); rejected.terminate(); }));
  assert.equal(response, 403);
  const trusted = new WebSocket(url, { origin: 'http://localhost:5173' }); f.sockets.add(trusted);
  const [raw] = await once(trusted, 'message'); assert.equal(JSON.parse(String(raw)).type, 'hello');
});

test('stale project IDs and invalid field types do not create or partially move sessions', async t => {
  const f = await fixture(t); f.store.createProject({ id: 'deleted' });
  f.store.deleteProjectRecord('deleted');
  f.store.upsertSession({ id: 'existing', cwd: f.dir, title: 'KEEP' });
  f.store.setSelectedId('existing'); const before = f.store.loadWorkspace(); const ptys = spawned.length;
  for (const [method, path, body] of [
    ['POST', '/api/sessions', { id: 'new', cwd: f.dir, projectId: 'deleted' }],
    ['PATCH', '/api/sessions/existing', { projectId: 'deleted', title: 'WRONG' }],
  ] as const) {
    const response = await f.request(method, path, body); assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'PROJECT_NOT_FOUND');
    assert.deepEqual(f.store.loadWorkspace(), before); assert.equal(spawned.length, ptys);
  }
  assert.equal((await f.request('PATCH', '/api/sessions/existing', { projectId: 42, title: 'WRONG' })).status, 400);
  assert.deepEqual(f.store.loadWorkspace(), before);
  assert.equal((await f.request('PATCH', '/api/sessions/existing', { projectId: null })).status, 200);
});

test('closing or killing a different session preserves selection; removing the selected one chooses a valid fallback', async t => {
  const f = await fixture(t);
  for (const id of ['a', 'b', 'c']) f.store.upsertSession({ id, cwd: f.dir });
  f.store.setSelectedId('b');
  for (const action of ['close', 'kill']) {
    const response = await f.request('POST', `/api/sessions/c/${action}`, {});
    assert.equal(response.status, 200); assert.equal((await response.json()).selectedId, 'b');
  }
  assert.equal((await (await f.request('POST', '/api/sessions/b/close', {})).json()).selectedId, 'a');
  assert.equal((await (await f.request('POST', '/api/sessions/a/close', {})).json()).selectedId, null);
});

// Uses a real paused TCP reader; PTY is the only simulated component.
/*
  一个观众卡住时，**它不该被掐掉**，其他人和这个终端也不该受影响。

  原来的做法是超过积压上限就 terminate。代价是它立刻重连、请求完整重放，从同一根还没
  疏通的管子里再挤一遍——手机或慢网上一次 resume 重打印就够触发这个循环。
  现在改成：丢掉这一帧，等 socket 疏通之后补一份完整基线（replay）。

  这条测试守的是那个协议契约：**任何一方都不该看到 seq 跳号**——要么连续，要么被一份
  replay 重置基线。跳号会让客户端把整条流判为无效。
*/
test('a stalled viewer is rebaselined instead of shed, and no one sees a sequence gap', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.store.upsertSession({ id: 'slow', cwd: f.dir });
  const live = f.runtime.ensureSession('slow', f.dir); const pty = latestPty();
  async function connect() {
    const ws = new WebSocket(f.base.replace('http', 'ws') + '/api/pty?id=slow'); f.sockets.add(ws);
    const [raw] = await once(ws, 'message'); const hello = JSON.parse(String(raw));
    const replay = once(ws, 'message'); ws.send(JSON.stringify({ type: 'ready', protocol: 2, instanceId: hello.instanceId })); await replay;
    return ws;
  }
  // 记录每个观众看到的东西：output 必须严格接续，replay 允许重置基线。
  function watch(ws: WebSocket) {
    const seen = { outputs: 0, replays: 0, gaps: 0, seq: 0 };
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.type === 'replay' || m.type === 'catchup') { seen.replays++; seen.seq = m.seq; return; }
      if (m.type !== 'output') return;
      if (m.seq !== seen.seq + 1) seen.gaps++;
      seen.seq = m.seq; seen.outputs++;
    });
    return seen;
  }

  const healthy = await connect(); const slow = await connect();
  const healthySeen = watch(healthy); const slowSeen = watch(slow);
  const underlying = (slow as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  underlying.pause();
  for (let i = 0; i < 256; i++) {
    pty.emitData('x'.repeat(65536));
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
  underlying.resume();

  /*
    等到它**真的追上了**，而不是等到「第一份基线到了」。

    补发的基线只是追赶的开头：它落在某个中间的 seq 上，后面的输出还在管子里排队。
    看到一份 replay 就往下走，测出来的是「刚好那一瞬间到哪儿了」——16MB 在一台正忙的
    机器上排得更久，这条测试就会红在与它无关的时候。收敛本身才是要断言的那件事。
  */
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (slowSeen.replays < 1 || slowSeen.seq !== healthySeen.seq))
    await new Promise<void>(r => setTimeout(r, 100));

  assert.equal(slow.readyState, WebSocket.OPEN, 'a stalled viewer must not be shed');
  // connect() 已经把最初那份 replay 消费掉了，所以这里数到的 replay 就是补发的基线。
  assert.ok(slowSeen.replays >= 1, `expected a rebaseline replay, saw ${slowSeen.replays}`);
  assert.equal(slowSeen.gaps, 0, 'the stalled viewer must never observe a sequence gap');
  // 最要紧的一条：它最后和健康的那个停在同一个位置，没有永久落后。
  assert.equal(slowSeen.seq, healthySeen.seq, 'the stalled viewer must end up caught up');

  const pong = once(healthy, 'pong'); healthy.ping(); await pong;
  assert.equal(healthy.readyState, WebSocket.OPEN);
  assert.equal(healthySeen.gaps, 0, 'a healthy peer must never observe a sequence gap');
  assert.equal(f.runtime.getSession('slow')?.pid, live.pid);
  healthy.send(JSON.stringify({ type: 'input', data: 'still usable' }));
  const barrier = once(healthy, 'pong'); healthy.ping(); await barrier;
  assert.equal(pty.writes.at(-1), 'still usable');
  const reconnected = await connect(); assert.equal(reconnected.readyState, WebSocket.OPEN);
});


test('file editing API saves atomically, returns mtime and detects external and concurrent edits', async t => {
  const fs = await import('node:fs/promises');
  const f = await fixture(t); const path = join(f.dir, 'edit.ts');
  f.store.upsertSession({id:'file-workspace',cwd:f.dir});
  await fs.writeFile(path, 'original', { mode: 0o755 });
  const read = async () => (await f.request('GET', '/api/file?' + new URLSearchParams({ root: f.dir, path: 'edit.ts' }))).json();
  const before = await read(); assert.equal(typeof before.mtime, 'number');
  const oldInode = (await fs.stat(path)).ino;
  const save = (content: string, mtime = before.mtime) => f.request('PUT', '/api/file', { root: f.dir, path: 'edit.ts', content, mtime });
  const response = await save('中文 new'); assert.equal(response.status, 200);
  const saved = await response.json(); assert.ok(saved.mtime > before.mtime);
  assert.equal((await read()).mtime, saved.mtime);
  assert.equal(await fs.readFile(path, 'utf8'), '中文 new');
  assert.notEqual((await fs.stat(path)).ino, oldInode);
  assert.equal((await fs.stat(path)).mode & 0o777, 0o755);
  const stale = await save('overwrite'); assert.equal(stale.status, 409);
  assert.equal((await stale.json()).content, '中文 new');
  await fs.writeFile(path, 'external');
  await fs.utimes(path, new Date(), new Date(saved.mtime + 1000));
  const external = await save('overwrite', saved.mtime); assert.equal(external.status, 409);
  const current = await external.json(); assert.equal(current.content, 'external');
  const concurrent = await Promise.all([save('tab A', current.mtime), save('tab B', current.mtime)]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  assert.ok((await concurrent.find(r => r.status === 200)!.json()).mtime > current.mtime);
  assert.equal((await fs.readdir(f.dir)).some(name => name.startsWith('.diy-save-')), false);
});

test('file editing validates fields, byte limits, binary files and symlink containment', async t => {
  const fs = await import('node:fs/promises');
  const f = await fixture(t); const path = join(f.dir, 'file.txt');
  f.store.upsertSession({id:'file-workspace',cwd:f.dir});
  await fs.writeFile(path, 'keep');
  const initial = (await fs.stat(path)).mtimeMs;
  const save = (extra: Record<string, unknown>) => f.request('PUT', '/api/file', { root: f.dir, path: 'file.txt', content: 'valid', mtime: initial, ...extra });
  for (const extra of [{ mtime: null }, { mtime: '123' }, { content: null }, { root: '' }, { path: '' }]) {
    assert.equal((await save(extra)).status, 400);
  }
  assert.equal((await save({ content: '中'.repeat(3000000) })).status, 413);
  assert.equal((await save({ content: 'a'.repeat(9000) + '\0' })).status, 415);
  assert.equal(await fs.readFile(path, 'utf8'), 'keep');
  await fs.mkdir(join(f.dir, 'inside'));
  await fs.symlink(f.dir, join(f.dir, 'inside', 'escape'));
  assert.equal((await save({ root: join(f.dir, 'inside'), path: '../file.txt' })).status, 403);
  assert.equal((await save({ root: join(f.dir, 'inside'), path: 'escape/file.txt' })).status, 403);
  assert.equal((await save({ path: 'missing.txt' })).status, 404);
  await fs.writeFile(path, 'b'.repeat(9000) + '\0');
  assert.equal((await save({ mtime: (await fs.stat(path)).mtimeMs })).status, 415);
  await fs.writeFile(path, 'keep');
  // Exactly 1 MiB is accepted even when JSON escaping expands it to 6 MiB (cap is 8 MiB content / ~48 MiB encoded).
  const large = await save({ content: '\u0001'.repeat(1024 * 1024), mtime: (await fs.stat(path)).mtimeMs });
  assert.equal(large.status, 200);
  assert.equal((await fs.stat(path)).size, 1024 * 1024);
  const preflight = await f.request('OPTIONS', '/api/file', undefined, { origin: 'http://localhost:5173' });
  assert.ok(preflight.headers.get('access-control-allow-methods')?.includes('PUT'));
});
