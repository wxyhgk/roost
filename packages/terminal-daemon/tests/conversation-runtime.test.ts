import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createPeerDeliveryOwner} from '../src/peer-delivery.ts';
import {startTerminalOwner} from '../src/owner.ts';
import {connectTerminalDaemon} from '../src/client.ts';
import {read, send} from '../src/wire.ts';

const errorIs = (status: number, code: string) => (error: any) => error.status === status && error.code === code;
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-runtime-'));
  const store = createWorkspaceStore({dataDir: dir}), bridge = createAiSessionBridge({storage: store.aiSessions});
  store.upsertSession({id: 'terminal', cwd: dir});
  bridge.bind({webSessionId: 'terminal', terminalInstanceId: 'instance', cliId: 'omp', nativeSessionId: 'native'});
  const cid = store.conversations.list().items[0]!.id;
  let live: any = {id: 'terminal', instanceId: 'instance', cli: 'omp', pid: 123};
  const owner = createPeerDeliveryOwner({store, ownerId: 'owner', runtime: {
    getSession: () => live,
    ensureSession: () => assert.fail('lookup must not start a terminal'),
    writeSession: () => assert.fail('lookup must not write to a terminal'),
  } as any, commands: {
    control: () => assert.fail('lookup must not require GUI control'),
    enqueue: () => assert.fail('lookup must not submit a command'),
  }});
  t.after(() => {owner.dispose(); store.close(); rmSync(dir, {recursive: true, force: true});});
  return {store, bridge, cid, owner, setLive(value: any) {live = value;}};
}

test('runtime lookup returns verified identity for a CLI without GUI sending and preserves the run', t => {
  const f = fixture(t); f.owner.start();
  const first = f.owner.resolveConversationRuntime(f.cid);
  assert.deepEqual(first, {conversationId: f.cid, runId: f.store.conversationRuns.active(f.cid)!.id,
    webSessionId: 'terminal', terminalInstanceId: 'instance', generation: f.bridge.get('terminal')!.generation,
    cliId: 'omp', nativeSessionId: 'native', runtimeVerified: true});
  assert.deepEqual(f.owner.resolveConversationRuntime(f.cid), first);
  assert.equal(f.store.conversationRuns.list().length, 1);
  assert.throws(() => f.owner.resolveConversationRuntime('missing'), errorIs(404, 'not_found'));
});

test('database active rows cannot certify an exited or replaced terminal instance', t => {
  const f = fixture(t); f.owner.start();
  f.setLive(undefined);
  assert.throws(() => f.owner.resolveConversationRuntime(f.cid), errorIs(409, 'run_unavailable'));
  f.setLive({id: 'terminal', instanceId: 'replacement', cli: 'omp', pid: 124});
  assert.throws(() => f.owner.resolveConversationRuntime(f.cid), errorIs(409, 'run_unavailable'));
});

test('a CLI switch before its new binding arrives is unavailable and trash cannot be continued', t => {
  const f = fixture(t); f.owner.start();
  f.setLive({id: 'terminal', instanceId: 'instance', cli: 'claude', pid: 123});
  assert.throws(() => f.owner.resolveConversationRuntime(f.cid), errorIs(409, 'run_unavailable'));
  assert.equal(f.store.conversationRuns.active(f.cid), undefined);
  f.setLive({id: 'terminal', instanceId: 'instance', cli: 'omp', pid: 123});
  assert.equal(f.owner.resolveConversationRuntime(f.cid).runtimeVerified, true);
  const record = f.store.conversations.get(f.cid);
  f.store.conversations.patch(f.cid, {revision: record.revision, trashed: true});
  assert.throws(() => f.owner.resolveConversationRuntime(f.cid), errorIs(409, 'conversation_trashed'));
});

test('lookup follows current binding and refuses stale conversations or a foreign owner', t => {
  const f = fixture(t); f.owner.start();
  const before = f.bridge.get('terminal')!;
  f.bridge.rebind({...before, nativeSessionId: 'new-native'}, before.generation, before.revision);
  assert.throws(() => f.owner.resolveConversationRuntime(f.cid), errorIs(409, 'run_unavailable'));
  const next = f.store.conversations.list().items.find(c => c.source.nativeSessionId === 'new-native')!.id;
  assert.equal(f.owner.resolveConversationRuntime(next).nativeSessionId, 'new-native');
  f.store.conversationRuns.retireOtherOwners('foreign');
  f.store.conversationRuns.observe(f.bridge.get('terminal')!, 'foreign');
  assert.throws(() => f.owner.resolveConversationRuntime(next), errorIs(409, 'run_unavailable'));
});

test('a stale binding observation cannot certify the old source after persisted identity changes', t => {
  const f = fixture(t); f.owner.start();
  const stale = f.store.aiSessions.list(), before = f.bridge.get('terminal')!;
  f.bridge.rebind({...before, nativeSessionId: 'new-native'}, before.generation, before.revision);
  // Simulate a cached observation while SQLite already holds the replacement binding.
  f.store.aiSessions.list = () => stale;
  assert.throws(() => f.owner.resolveConversationRuntime(f.cid), errorIs(409, 'run_unavailable'));
});

test('terminal lookup follows the current binding across multiple historical conversations', t => {
  const f = fixture(t); f.owner.start();
  assert.equal(f.owner.resolveTerminalConversation('terminal').conversationId, f.cid);
  assert.throws(() => f.owner.resolveTerminalConversation('missing'), errorIs(404, 'not_found'));
  f.store.upsertSession({id: 'unbound', cwd: '/tmp'});
  assert.throws(() => f.owner.resolveTerminalConversation('unbound'), errorIs(409, 'run_unavailable'));
  const before = f.bridge.get('terminal')!;
  f.bridge.rebind({...before, nativeSessionId: 'second'}, before.generation, before.revision);
  const second = f.owner.resolveTerminalConversation('terminal');
  assert.notEqual(second.conversationId, f.cid);
  const current = f.bridge.get('terminal')!;
  f.bridge.rebind({...current, nativeSessionId: 'native'}, current.generation, current.revision);
  assert.equal(f.owner.resolveTerminalConversation('terminal').conversationId, f.cid, 'resume an older conversation without selecting latest history');
  f.setLive({id: 'terminal', instanceId: 'instance', cli: 'claude', pid: 123});
  assert.throws(() => f.owner.resolveTerminalConversation('terminal'), errorIs(409, 'run_unavailable'));
});

test('runtime resolver crosses a real owner socket and never launches or writes on lookup', {timeout: 15000}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-ipc-')), socketPath = join(dir, 'owner.sock'), shell = join(dir, 'shell');
  writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n', {mode: 0o700});
  const owner = await startTerminalOwner({dataDir: dir, socketPath, shell, defaultCwd: dir});
  const store = createWorkspaceStore({dataDir: dir}), bridge = createAiSessionBridge({storage: store.aiSessions});
  const client = await connectTerminalDaemon(socketPath);
  t.after(async () => {client.dispose(); await owner.stop(); store.close(); rmSync(dir, {recursive: true, force: true});});
  store.upsertSession({id: 'terminal', cwd: dir});
  const terminal = await client.ensureSession('terminal', dir);
  // Only CLI recognition is synthetic. PTY, socket, client, owner and SQLite are real.
  const get = owner.runtime.getSession;
  owner.runtime.getSession = id => {const live = get(id); return live ? {...live, cli: 'omp'} : live;};
  bridge.bind({webSessionId: 'terminal', terminalInstanceId: terminal.instanceId, cliId: 'omp', nativeSessionId: 'native'});
  const cid = store.conversations.list().items[0]!.id;
  owner.runtime.ensureSession = () => assert.fail('resolver cannot launch');
  owner.runtime.writeSession = () => assert.fail('resolver cannot write');
  const result = await client.resolveConversationRuntime!(cid);
  assert.deepEqual(await client.resolveTerminalConversation!('terminal'), result);
  await assert.rejects(client.resolveTerminalConversation!('missing'), errorIs(404, 'not_found'));
  assert.equal(result.terminalInstanceId, terminal.instanceId); assert.equal(result.runtimeVerified, true);
  await assert.rejects(client.resolveConversationRuntime!('missing'), errorIs(404, 'not_found'));
  const record = store.conversations.get(cid);
  const trashed = store.conversations.patch(cid, {revision: record.revision, trashed: true});
  await assert.rejects(client.resolveConversationRuntime!(cid), errorIs(409, 'conversation_trashed'));
  await assert.rejects(client.resolveTerminalConversation!('terminal'), errorIs(409, 'conversation_trashed'));
  store.conversations.patch(cid, {revision: trashed.revision, trashed: false});
  await client.killSession('terminal');
  await assert.rejects(client.resolveConversationRuntime!(cid), errorIs(409, 'run_unavailable'));
  await assert.rejects(client.resolveTerminalConversation!('terminal'), errorIs(409, 'run_unavailable'));
});

test('a legacy daemon without the capability returns 503 without sending an unknown RPC', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-legacy-')), path = join(dir, 'old.sock');
  let requests = 0;
  const server = createServer(socket => {
    send(socket, {type: 'hello', version: 1, pid: process.pid, sessions: [], capabilities: ['ai-command-v1']});
    read(socket, () => {requests++;});
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const client = await connectTerminalDaemon(path);
  t.after(async () => {client.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, {recursive: true, force: true});});
  await assert.rejects(client.resolveConversationRuntime!('conversation'), errorIs(503, 'runtime_unavailable'));
  await assert.rejects(client.resolveTerminalConversation!('terminal'), errorIs(503, 'runtime_unavailable'));
  assert.equal(requests, 0);
  client.dispose();
  await assert.rejects(client.resolveConversationRuntime!('conversation'), errorIs(503, 'runtime_unavailable'));
});
