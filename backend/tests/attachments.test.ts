import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { latestPty } from './helpers/fake-pty.ts';
import { createAttachmentStore, MAX_ATTACHMENT_BYTES } from '../src/attachments.ts';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'roost-attachments-'));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
  const directory = join(dir, 'attachments');
  const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir, attachments: createAttachmentStore({ directory }) });
  const id = '../arbitrary/session';
  store.upsertSession({ id, cwd: dir });
  const live = runtime.ensureSession(id, dir);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    runtime.dispose(); store.close(); await fs.rm(dir, { recursive: true, force: true });
  });
  const form = (bytes: Buffer, instanceId = live.instanceId) => {
    const data = new FormData(); data.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), '../../wrong.jpg');
    data.append('instanceId', instanceId); return data;
  };
  const upload = (data: FormData, session = id, origin?: string) => fetch(`${base}/api/sessions/${encodeURIComponent(session)}/attachments`, {
    method: 'POST', body: data, headers: origin ? { origin } : {},
  });
  return { dir, directory, base, store, runtime, id, live, form, upload };
}
const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#ff0000' } }).png().toBuffer();

test('image uploads preserve bytes, detect MIME, isolate sessions, survive runtime exit and never send terminal input', async t => {
  const f = await fixture(t);
  for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
    const bytes = await sharp(png).toFormat(format).toBuffer();
    const response = await f.upload(f.form(bytes)); assert.equal(response.status, 201);
    const result = await response.json();
    assert.deepEqual(result.insertion, { kind: "unsupported", reason: "unknown-cli" });
    assert.deepEqual(latestPty().writes, []);
    assert.equal(result.mime, mime); assert.equal(result.sessionId, f.id); assert.equal(result.instanceId, f.live.instanceId);
    assert.equal(result.width, 16); assert.equal(result.height, 12); assert.equal(result.size, bytes.length);
    assert.match(result.name, /^[a-f0-9-]+\.(png|jpg|webp)$/);
    assert.ok(result.path.startsWith(await fs.realpath(f.directory) + '/'));
    assert.deepEqual(await fs.readFile(result.path), bytes);
    assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
    assert.equal((await fs.readdir(join(result.path, '..'))).some(name => name.endsWith('.tmp')), false);
    if (format === 'webp') {
      f.runtime.killSession(f.id);
      assert.deepEqual(await fs.readFile(result.path), bytes);
    }
  }
});

test('invalid image uploads and stale or missing sessions fail without creating attachments', async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.from('not an image'), png.subarray(0, 40), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
    assert.equal((await f.upload(f.form(bytes))).status, 415);
  }
  assert.equal((await f.upload(f.form(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)))).status, 413);
  assert.equal((await f.upload(f.form(png, 'old-instance'))).status, 409);
  assert.equal((await f.upload(f.form(png), 'missing')).status, 404);
  assert.equal((await f.upload(f.form(png), f.id, 'https://evil.test')).status, 403);
  const duplicate = f.form(png); duplicate.append('file', new Blob([new Uint8Array(png)]), 'another.png');
  assert.equal((await f.upload(duplicate)).status, 400);
  const extra = f.form(png); extra.append('root', '/tmp'); assert.equal((await f.upload(extra)).status, 400);
  f.store.setSessionClosed(f.id, true); assert.equal((await f.upload(f.form(png))).status, 409);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('restart during multipart upload rejects the old instance without storing a file', async t => {
  const f = await fixture(t);
  const { request } = await import('node:http');
  const boundary = 'roost-test-boundary';
  const req = request(`${f.base}/api/sessions/${encodeURIComponent(f.id)}/attachments`, {
    method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  req.write(`--${boundary}\r\nContent-Disposition: form-data; name="instanceId"\r\n\r\n${f.live.instanceId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
  await new Promise(r => setTimeout(r, 30));
  f.runtime.killSession(f.id); f.runtime.ensureSession(f.id, f.dir);
  req.end(Buffer.concat([png, Buffer.from(`\r\n--${boundary}--\r\n`)]));
  const [res] = await once(req, 'response'); res.resume(); assert.equal(res.statusCode, 409);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('upload concurrency is bounded and malformed multipart releases the slot', async t => {
  const f = await fixture(t); const { request } = await import('node:http');
  const pending = [0, 1].map(() => {
    const req = request(`${f.base}/api/sessions/${encodeURIComponent(f.id)}/attachments`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test' } });
    req.on('error', () => {}); req.write('--test\r\n'); return req;
  });
  t.after(() => pending.forEach(req => req.destroy()));
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await f.upload(f.form(png))).status, 429);
  for (const req of pending) {
    const response = once(req, 'response'); req.end(); const [res] = await response; res.resume(); assert.equal(res.statusCode, 400);
  }
  assert.equal((await f.upload(f.form(png))).status, 201);
});

test('aborted uploads release capacity, keep HTTP alive, and oversized image dimensions are rejected', async t => {
  const f = await fixture(t); const { request } = await import('node:http');
  const req = request(`${f.base}/api/sessions/${encodeURIComponent(f.id)}/attachments`, {
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test' },
  });
  req.on('error', () => {}); req.write('--test\r\n');
  await new Promise(r => setTimeout(r, 30)); req.destroy();
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await fetch(f.base + '/api/health')).status, 200);
  // Compresses well under the byte limit, but exceeds the decoded pixel budget.
  const large = await sharp({ create: { width: 5001, height: 5000, channels: 3, background: 'white' } }).png().toBuffer();
  assert.ok(large.length < MAX_ATTACHMENT_BYTES);
  assert.equal((await f.upload(f.form(large))).status, 415);
  assert.equal((await f.upload(f.form(png))).status, 201);
});


test('adapter discovery exposes candidates honestly and respects the access guard', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/api/cli-adapters');
  assert.equal(response.status, 200);
  const { adapters } = await response.json();
  assert.equal(adapters.length, 5);
  assert.deepEqual(adapters.find((a: {id: string}) => a.id === 'qwen').verifiedVersions, ['0.21.14']);
  assert.deepEqual(adapters.find((a: {id: string}) => a.id === 'opencode').verifiedVersions, []);
  assert.equal((await fetch(f.base + '/api/cli-adapters', { headers: { origin: 'https://evil.test' } })).status, 403);
});

test('OpenCode gets an adapter plan while existing v2 clients still receive a compatible CLI value', async t => {
  const f = await fixture(t);
  const getSession = f.runtime.getSession;
  f.runtime.getSession = id => { const live = getSession(id); return live ? { ...live, cli: 'opencode' } : live; };
  const response = await f.upload(f.form(png));
  assert.equal(response.status, 201);
  const attachment = await response.json();
  assert.equal(attachment.insertion.cli, 'opencode');
  assert.equal(attachment.insertion.requiresConfirmation, false);
  assert.equal(attachment.insertion.data, `\x1b[200~${attachment.path}\x1b[201~`);
  const workspace = await (await fetch(f.base + '/api/workspace')).json();
  assert.equal(workspace.sessions[0].cli, null);
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(f.base.replace('http', 'ws') + '/api/pty?id=' + encodeURIComponent(f.id));
  t.after(() => ws.terminate());
  const [raw] = await once(ws, 'message');
  assert.equal(JSON.parse(String(raw)).cli, null);
  ws.terminate();
});

test('attachment usage and explicit cleanup include orphaned sessions and protect live hidden terminals', async t => {
  const f=await fixture(t);
  const uploaded=await (await f.upload(f.form(png))).json();
  let response=await fetch(f.base+'/api/attachments');assert.equal(response.status,200);
  let usage=await response.json();assert.equal(usage.count,1);assert.equal(usage.bytes,png.length);
  const group=usage.sessions[0];assert.equal(group.sessionId,f.id);assert.equal(group.running,true);
  const endpoint=f.base+`/api/attachments/${group.sessionKey}`;
  const listing=await (await fetch(endpoint)).json();assert.equal(listing.files[0].name,uploaded.name);
  assert.equal(listing.files[0].size,png.length);
  assert.equal((await fetch(endpoint+'/'+uploaded.name,{method:'DELETE'})).status,409);
  f.store.setSessionClosed(f.id,true);
  assert.equal((await fetch(endpoint+'/'+uploaded.name,{method:'DELETE'})).status,409);
  assert.deepEqual(await fs.readFile(uploaded.path),png);
  f.runtime.killSession(f.id);f.store.deleteSessionRecord(f.id);
  usage=await (await fetch(f.base+'/api/attachments')).json();
  assert.equal(usage.sessions[0].sessionId,null);assert.equal(usage.sessions[0].running,false);
  const removed=await fetch(endpoint+'/'+uploaded.name,{method:'DELETE'});assert.equal(removed.status,200);
  assert.equal((await removed.json()).bytes,png.length);
  assert.equal((await fetch(endpoint+'/'+uploaded.name,{method:'DELETE'})).status,404);
  assert.equal((await (await fetch(f.base+'/api/attachments')).json()).count,0);
});

test('attachment catalog ignores symlinks and refuses non-managed names', async t => {
  const f=await fixture(t);const uploaded=await (await f.upload(f.form(png))).json();
  const usage=await (await fetch(f.base+'/api/attachments')).json();
  const key=usage.sessions[0].sessionKey,endpoint=f.base+`/api/attachments/${key}`;
  const outside=join(f.dir,'keep.png');await fs.writeFile(outside,png);
  const fake='00000000-0000-0000-0000-000000000000.png';
  await fs.symlink(outside,join(f.directory,key,fake));
  assert.equal((await (await fetch(endpoint)).json()).files.length,1);
  assert.equal((await fetch(endpoint+'/'+fake,{method:'DELETE'})).status,403);
  assert.equal((await fetch(endpoint+'/unknown.tmp',{method:'DELETE'})).status,400);
  assert.equal((await fetch(f.base+'/api/attachments/not-a-key')).status,400);
  assert.deepEqual(await fs.readFile(outside),png);assert.deepEqual(await fs.readFile(uploaded.path),png);
});
