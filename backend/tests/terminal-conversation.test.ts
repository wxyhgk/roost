import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import type {TerminalService, ConversationRuntime} from '@roost/terminal-runtime';
import {createPeerDeliveryOwner} from '../../packages/terminal-daemon/src/peer-delivery.ts';
import {handleConversationRuntime} from '../src/conversation-runtime.ts';

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-conversation-http-'));
  const store = createWorkspaceStore({dataDir: dir}), bridge = createAiSessionBridge({storage: store.aiSessions});
  const live = new Map<string, any>(); let connected = true;
  // Real SQLite, resolver and HTTP handler; CLI observation and IPC scheduling are controlled.
  const runtime = {getSession: (id: string) => live.get(id), isConnected: () => connected,
    ensureSession: () => assert.fail('read-only lookup cannot launch'),
    writeSession: () => assert.fail('read-only lookup cannot write')} as unknown as TerminalService;
  const owner = createPeerDeliveryOwner({store, runtime: runtime as any, ownerId: 'test-owner', commands: {
    control: () => assert.fail('lookup cannot require GUI control'), enqueue: () => assert.fail('lookup cannot enqueue'),
  }});
  runtime.resolveTerminalConversation = async id => owner.resolveTerminalConversation(id);
  runtime.resolveConversationRuntime = async id => owner.resolveConversationRuntime(id);
  owner.start();
  const server = createServer((req, res) => {void handleConversationRuntime(req, res, new URL(req.url!, 'http://localhost'), store, runtime).then(handled => {if (!handled) {res.statusCode = 404; res.end();}});});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  t.after(async () => {owner.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, {recursive: true, force: true});});
  function bind(id: string, native: string) {
    store.upsertSession({id, cwd: dir}); live.set(id, {id, cwd: dir, instanceId: 'instance-' + id, pid: 42, cli: 'omp'});
    const before = bridge.get(id), input = {webSessionId: id, terminalInstanceId: 'instance-' + id, cliId: 'omp', nativeSessionId: native};
    if (before) bridge.rebind(input, before.generation, before.revision); else bridge.bind(input);
    return store.conversations.list({state: 'all'}).items.find(c => c.source.nativeSessionId === native)!.id;
  }
  const request = async (id: string, status = 200, code?: string, suffix = '') => {
    const response = await fetch(base + '/api/sessions/' + id + '/conversation' + suffix);
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body));
    if (code) assert.equal(body.error.code, code); return body as ConversationRuntime;
  };
  return {store, bridge, runtime, live, owner, bind, request, disconnect: () => {connected = false;}, reconnect: () => {connected = true;}};
}

test('follow terminal HTTP resolves the actual binding rather than latest historical conversation', async t => {
  const f = await fixture(t), first = f.bind('terminal', 'first');
  assert.equal((await f.request('terminal')).conversationId, first);
  const second = f.bind('terminal', 'second');
  assert.equal((await f.request('terminal')).conversationId, second);
  f.bind('terminal', 'first');
  assert.equal((await f.request('terminal')).conversationId, first);
  await f.request('unknown', 404, 'not_found');
  f.store.upsertSession({id: 'unbound', cwd: '/tmp'});
  await f.request('unbound', 409, 'run_unavailable');
  f.live.set('terminal', {...f.live.get('terminal'), cli: 'claude'});
  await f.request('terminal', 409, 'run_unavailable');
  f.bind('terminal', 'first');
  const record = f.store.conversations.get(first);
  f.store.conversations.patch(first, {revision: record.revision, trashed: true});
  await f.request('terminal', 409, 'conversation_trashed');
});

test('follow HTTP rejects old or disconnected daemons and a binding that changes while IPC is awaited', async t => {
  const f = await fixture(t); f.bind('terminal', 'first');
  const resolve = f.runtime.resolveTerminalConversation!;
  delete f.runtime.resolveTerminalConversation;
  await f.request('terminal', 503, 'runtime_unavailable'); f.runtime.resolveTerminalConversation = resolve;
  f.disconnect(); await f.request('terminal', 503, 'runtime_unavailable'); f.reconnect();
  f.runtime.resolveTerminalConversation = async id => {
    const result = await resolve(id); f.bind(id, 'changed-during-rpc'); return result;
  };
  await f.request('terminal', 409, 'run_unavailable');
  f.runtime.resolveTerminalConversation = resolve;
  assert.equal((await f.request('terminal')).nativeSessionId, 'changed-during-rpc');
  f.bind('another', 'other-terminal');
  f.runtime.resolveTerminalConversation = () => resolve('another');
  await f.request('terminal', 409, 'run_unavailable');
  f.runtime.resolveTerminalConversation = resolve;
  await f.request('terminal', 400, 'invalid_request', '?latest=true');
});
