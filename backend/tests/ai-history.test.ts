import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createAiSessionBridge, AiHistoryError } from '@roost/ai-session-bridge';
import { readOmpTranscript } from '@roost/ai-transcript';
import { handleAiHistory } from '../src/ai-history.ts';
import './helpers/fake-pty.ts';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-ai-history-http-'));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  const server = createBackendServer({ auth: false, store, runtime, sessionBridge: bridge, workspaceRoot: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, runtime, bridge, request: (path: string, method = 'GET') => fetch(base + path, { method }) };
}

test('history HTTP paginates archived generations and messages without a live PTY', async t => {
  const f = await fixture(t);
  const binding = f.bridge.bind({ webSessionId: 'web', terminalInstanceId: 'i', cliId: 'claude', nativeSessionId: 'a' });
  for (let i = 0; i < 3; i++) f.bridge.publish('web', { type: 'message', eventId: `event/${i}`, role: 'assistant', content: `body ${i}` });
  const current = f.bridge.get('web')!;
  const second = f.bridge.rebind({ webSessionId: 'web', terminalInstanceId: 'i', cliId: 'claude', nativeSessionId: 'b' }, current.generation, current.revision);
  assert.equal(f.runtime.getSession('web'), undefined);
  const prefix = '/api/ai-sessions/web/generations';
  const generations = await (await f.request(prefix + '?limit=1')).json();
  assert.equal(generations.items.length, 1);
  assert.equal(generations.items[0].generation, second.generation);
  const older = await (await f.request(prefix + '?limit=1&beforeOrdinal=' + generations.nextBeforeOrdinal)).json();
  assert.equal(older.items[0].generation, binding.generation);
  const messages = `${prefix}/${encodeURIComponent(binding.generation)}/messages`;
  const first = await (await f.request(messages + '?limit=2')).json();
  assert.equal(first.items.length, 2); assert.equal(first.hasMore, true);
  const next = await (await f.request(messages + '?limit=2&cursor=' + encodeURIComponent(first.nextCursor))).json();
  assert.equal(next.items.length, 1); assert.equal(next.hasMore, false);
  assert.equal(new Set([...first.items, ...next.items].map(item => item.messageId)).size, 3);
  const detail = await f.request(messages + '/' + encodeURIComponent(first.items[0].messageId));
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).event.content, first.items[0].event.content);
  assert.equal((await f.request(messages + '?cursor=notvalid')).status, 400);
  assert.equal((await f.request(prefix + '/unknown/messages')).status, 404);
  assert.equal((await f.request('/api/ai-sessions/unknown/generations')).status, 404);
});

test('history HTTP detail survives transcript source deletion', async t => {
  const f = await fixture(t), path = join(f.dir, 'native.jsonl');
  writeFileSync(path, [
    { type: 'session', version: 3, id: 'native' },
    { type: 'message', id: 'row', message: { role: 'assistant', content: [{ type: 'text', text: 'durable body' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const binding = f.bridge.bind({ webSessionId: 'transcript', terminalInstanceId: 'i', cliId: 'omp', nativeSessionId: 'native', transcriptPath: path });
  f.bridge.ingestTranscript('transcript', binding.generation, await readOmpTranscript(path, 'native'));
  unlinkSync(path);
  const prefix = `/api/ai-sessions/transcript/generations/${encodeURIComponent(binding.generation)}/messages`;
  const page = await (await f.request(prefix)).json();
  assert.equal(page.items.length, 1);
  const response = await f.request(prefix + '/' + encodeURIComponent(page.items[0].messageId));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).event.content, 'durable body');
});

test('history HTTP rejects malformed requests and unsupported methods with stable JSON codes', async t => {
  const f = await fixture(t), path = '/api/ai-sessions/web/generations';
  for (const suffix of ['?limit=0', '?limit=201', '?limit=1.5', '?limit=1&limit=2', '?beforeOrdinal=-1', '?other=1']) {
    const response = await f.request(path + suffix);
    assert.equal(response.status, 400, suffix); assert.equal((await response.json()).error.code, 'invalid_request');
  }
  for (const malformed of ['/api/ai-sessions/%E0%A4%A/generations', path + '/gen/messages?cursor=', path + '/gen/messages/msg?limit=1']) {
    assert.equal((await f.request(malformed)).status, 400, malformed);
  }
  const method = await f.request(path, 'POST');
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
  assert.equal((await method.json()).error.code, 'method_not_allowed');
});

test('history handler preserves stale cursor 409 and masks SQLite failures as 503', async t => {
  let error: Error = new AiHistoryError(409, 'history_cursor_expired', 'history changed');
  const server = createServer((req, res) => handleAiHistory(req, res, new URL(req.url!, 'http://localhost'), {
    listGenerations() { throw error; }, pageMessages() { throw error; }, getMessage() { throw error; },
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/ai-sessions/web/generations/g/messages?cursor=abc`;
  let response = await fetch(url);
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'history_cursor_expired');
  error = new Error('SQLITE_BUSY secret db path');
  response = await fetch(url);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: { code: 'storage_unavailable', message: 'AI history storage unavailable' } });
});
