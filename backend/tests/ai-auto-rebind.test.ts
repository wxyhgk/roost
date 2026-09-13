import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { createAiSessionBridge } from '@roost/ai-session-bridge';
import type { TerminalEvent } from '@roost/terminal-runtime';
import './helpers/fake-pty.ts';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

type Entry = { terminalInstanceId: string; sourceSeq: number; agent: { event: 'session_start' | 'stop'; sessionId: string; response?: string } };
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2500;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'controlled replay did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-auto-rebind-'));
  const store = createWorkspaceStore({ dataDir: dir });
  store.upsertSession({ id: 'web', cwd: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  const first = bridge.bind({ webSessionId: 'web', terminalInstanceId: 'instance', cliId: 'claude', nativeSessionId: 'a' });
  bridge.publish('web', { eventId: 'instance:1', type: 'message', role: 'assistant', content: 'body A' }, { cursor: 1, hasGap: false });
  const listeners = new Set<(event: TerminalEvent) => void>();
  runtime.subscribe = (_id, callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
  runtime.getSession = id => id === 'web' ? { id, cwd: dir, pid: 1, instanceId: 'instance', cli: 'claude' } : undefined;
  let page: { events: Entry[]; cursor: number; highWater: number; more: boolean; hasGap: boolean } | undefined;
  let reads = 0;
  Object.assign(runtime, {
    supportsAgentReplay: () => true,
    readAgentEvents: async (_id: string, _instance: string, after: number) => {
      reads++;
      const result = page; page = undefined;
      return result ?? { events: [], cursor: after, highWater: after, more: false, hasGap: false };
    },
  });
  const server = createBackendServer({ auth: false, store, runtime, sessionBridge: bridge, workspaceRoot: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const request = async (path = '/api/ai-sessions/web') => {
    const response = await fetch(base + path); assert.equal(response.status, 200); return response.json();
  };
  async function connect() {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/ai-sessions/web/events?afterSeq=0'); sockets.add(ws);
    const [data] = await once(ws, 'message', { signal: AbortSignal.timeout(2500) });
    return { ws, snapshot: JSON.parse(data.toString()) };
  }
  async function replay(events: Entry[], hasGap = false) {
    const previous = reads;
    page = { events, cursor: Math.max(...events.map(e => e.sourceSeq)), highWater: Math.max(...events.map(e => e.sourceSeq)), more: false, hasGap };
    for (const notify of listeners) notify({ type: 'agent', ...events[0] });
    await until(() => reads > previous);
    // HTTP executes after the replay's resolved promise continuation and gives a committed snapshot.
    return request();
  }
  return { dir, store, bridge, first, request, connect, replay };
}
const event = (sourceSeq: number, sessionId: string, response?: string, terminalInstanceId = 'instance'): Entry => ({ terminalInstanceId, sourceSeq, agent: { event: response === undefined ? 'session_start' : 'stop', sessionId, ...(response === undefined ? {} : { response }) } });

test('reliable A to B to A replay closes old streams and retains independent generations with shared conversation identity', { timeout: 10000 }, async t => {
  const f = await fixture(t), a = await f.connect();
  const aClosed = once(a.ws, 'close', { signal: AbortSignal.timeout(2500) });
  await f.replay([event(2, 'b'), event(3, 'b', 'body B')]);
  assert.equal((await aClosed)[0], 1008);
  const b = await f.connect();
  assert.equal(b.snapshot.binding.nativeSessionId, 'b');
  assert.deepEqual(b.snapshot.events.filter((e: any) => e.event.type === 'message').map((e: any) => e.event.content), ['body B']);
  const bClosed = once(b.ws, 'close', { signal: AbortSignal.timeout(2500) });
  await f.replay([event(4, 'a')]);
  assert.equal((await bClosed)[0], 1008);
  const aAgain = await f.connect();
  assert.equal(aAgain.snapshot.binding.nativeSessionId, 'a');
  assert.notEqual(aAgain.snapshot.binding.generation, f.first.generation);
  assert.ok(aAgain.snapshot.events.every((e: any) => e.event.content !== 'body B'));
  const history = await f.request('/api/ai-sessions/web/generations');
  assert.equal(history.items.length, 3);
  assert.equal(history.items[0].conversationId, history.items[2].conversationId);
  assert.notEqual(history.items[0].conversationId, history.items[1].conversationId);
  for (const [index, body] of [[1, 'body B'], [2, 'body A']] as const) {
    const messages = await f.request(`/api/ai-sessions/web/generations/${history.items[index].generation}/messages`);
    assert.deepEqual(messages.items.map((m: any) => m.event.content), [body]);
  }
  const generation = f.bridge.get('web')!.generation;
  await f.replay([event(2, 'b'), event(3, 'b', 'body B')]);
  assert.equal(f.bridge.get('web')!.generation, generation);
  await f.replay([event(5, 'b', undefined, 'old-instance')]);
  assert.equal(f.bridge.get('web')!.generation, generation);
  assert.equal(aAgain.ws.readyState, WebSocket.OPEN);
  assert.equal((await f.request('/api/ai-sessions/web/generations')).items.length, 3);
});

test('replay gap with existing body requires confirmation without closing the stream or archiving a new generation', { timeout: 10000 }, async t => {
  const f = await fixture(t), connection = await f.connect();
  const snapshot = await f.replay([event(3, 'b')], true);
  assert.equal(snapshot.sync.lastError, 'needs_rebind');
  assert.deepEqual(snapshot.sync.pendingIdentity, { nativeSessionId: 'b', reason: 'source_gap' });
  assert.equal(f.bridge.source('web').cursor, 1);
  assert.equal(f.bridge.source('web').hasGap, true);
  assert.equal(f.bridge.get('web')!.generation, f.first.generation);
  assert.equal(connection.ws.readyState, WebSocket.OPEN);
  assert.equal((await f.request('/api/ai-sessions/web/generations')).items.length, 1);
  assert.ok(snapshot.events.some((e: any) => e.event.content === 'body A'));
});

test('failed SQLite archive transaction leaves old binding, body and websocket intact and can retry', { timeout: 10000 }, async t => {
  const f = await fixture(t), connection = await f.connect();
  const db = new DatabaseSync(join(f.dir, 'workspace.sqlite'));
  try {
    db.exec(`CREATE TRIGGER reject_auto_generation BEFORE INSERT ON ai_generations WHEN NEW.generation <> '${f.first.generation}' BEGIN SELECT RAISE(ABORT, 'injected generation failure'); END`);
    await f.replay([event(2, 'b')]);
    assert.equal(f.bridge.get('web')!.generation, f.first.generation);
    assert.equal(connection.ws.readyState, WebSocket.OPEN);
    assert.equal((await f.request('/api/ai-sessions/web/generations')).items.length, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ai_conversations').get() as {n: number}).n, 1);
    assert.equal((db.prepare('SELECT closed_at FROM ai_generations').get() as {closed_at: number | null}).closed_at, null);
    assert.equal(f.bridge.source('web').cursor, 1);
    const messages = await f.request(`/api/ai-sessions/web/generations/${f.first.generation}/messages`);
    assert.deepEqual(messages.items.map((m: any) => m.event.content), ['body A']);
    db.exec('DROP TRIGGER reject_auto_generation');
    const closed = once(connection.ws, 'close', { signal: AbortSignal.timeout(2500) });
    await f.replay([event(2, 'b')]);
    assert.equal((await closed)[0], 1008);
    assert.equal((await f.request('/api/ai-sessions/web/generations')).items.length, 2);
  } finally { db.close(); }
});
