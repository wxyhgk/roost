import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createWorkspaceStore } from '@roost/workspace-store';
import { createAiSessionBridge } from '@roost/ai-session-bridge';
import { createAiCommandOwner } from '../../packages/terminal-daemon/src/ai-command-owner.ts';
import { createPeerDeliveryOwner } from '../../packages/terminal-daemon/src/peer-delivery.ts';
import './helpers/fake-pty.ts';
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(20); }
  assert.fail(label);
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-gateway-resilience-'));
  const ownerStore = createWorkspaceStore({ dataDir: dir });
  const transcriptPath = join(dir, 'synthetic-native.jsonl');
  writeFileSync(transcriptPath, '');
  ownerStore.upsertSession({ id: 'B', cwd: dir });
  const bridge = createAiSessionBridge({ storage: ownerStore.aiSessions });
  const binding = bridge.bind({ webSessionId: 'B', terminalInstanceId: 'instance-B', cliId: 'claude', nativeSessionId: 'synthetic-native-B', transcriptPath });
  const conversationId = ownerStore.conversations.list().items[0]!.id;
  const live = { id: 'B', instanceId: 'instance-B', cli: 'claude' as const, cwd: dir, pid: 123 };
  const underlying = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: ownerStore });
  const writes: string[] = [];
  const runtime = { ...underlying, getSession: (id: string) => id === 'B' ? live : undefined,
    writeSession(id: string, text: string) {
      assert.equal(id, 'B');
      assert.ok(text.startsWith('\x1b[200~') && text.endsWith('\x1b[201~\r'), 'only the command owner can submit the simulated CLI prompt');
      writes.push(text.slice('\x1b[200~'.length, -'\x1b[201~\r'.length));
    } };
  const commands = createAiCommandOwner({ store: ownerStore, runtime, ownerId: 'resilience-owner', enabled: true,
    // 前台归属注入：真实现要跑 ps 判断「这条 PTY 的前台是谁」，而这里的 pid 是假的，
    // 会被判成「判断不了」从而拒绝一切写入。这条链路测的不是那道闸，直接喂真值。
    foreground: async () => 'claude',
    recoverOnCreate: false, changed: () => {}, acceptanceMs: 60_000, now: () => 1000 });
  commands.ensure(live);
  let hookSeq = 1, outputSeq = 0;
  commands.hook('B', { event: 'SessionStart', sessionId: binding.nativeSessionId, version: '2.1.266' }, hookSeq);
  function composer(text = '') {
    commands.output('B', { type: 'output', instanceId: live.instanceId, seq: ++outputSeq,
      data: '\x1b[2J\x1b[HClaude Code v2.1.266\r\n────────────────────────────────────────\r\n❯ ' + text +
        '\r\n────────────────────────────────────────\r\nshift+tab to cycle\x1b[3;' + (3 + text.length) + 'H' });
  }
  composer();
  await until(() => commands.control('B').reason === null, 'synthetic composer must settle');
  const coordinator = createPeerDeliveryOwner({ store: ownerStore, runtime, commands, ownerId: 'resilience-owner' });
  coordinator.start();
  type Gateway = { server: ReturnType<typeof createBackendServer>; store: ReturnType<typeof createWorkspaceStore>; base: string; closed: boolean };
  const gateways: Gateway[] = [], sockets: WebSocket[] = [];
  async function openGateway() {
    // A new gateway has its own SQLite connection and stream epoch. The command
    // owner and simulated native process survive that gateway's lifetime.
    const store = createWorkspaceStore({ dataDir: dir });
    const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const gateway = { server, store, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, closed: false };
    gateways.push(gateway); return gateway;
  }
  async function closeGateway(gateway: Gateway) {
    if (gateway.closed) return;
    gateway.closed = true;
    gateway.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => gateway.server.close(error => error ? reject(error) : resolve()));
    gateway.store.close();
  }
  function connect(gateway: Gateway, cursor: string) {
    const ws = new WebSocket(`${gateway.base.replace('http:', 'ws:')}/api/conversations/${conversationId}/stream?cursor=${encodeURIComponent(cursor)}`);
    const frames: any[] = []; sockets.push(ws);
    ws.on('error', () => {});
    ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    return { ws, frames, async wait(predicate: (frame: any) => boolean) {
      await until(() => frames.some(predicate), 'expected conversation stream frame');
      return frames.find(predicate);
    } };
  }
  const request = (gateway: Gateway, suffix: string, body?: unknown) => fetch(gateway.base + suffix, {
    method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  function receipt(index: number) {
    const text = writes[index]; assert.ok(text, 'native receipt can only follow an actual simulated write');
    // Only this boundary is synthetic: a hook and a matching newly appended
    // native user record. The actual command owner performs the evidence check.
    commands.hook('B', { event: 'UserPromptSubmit', sessionId: binding.nativeSessionId, prompt: text }, ++hookSeq);
    appendFileSync(transcriptPath, JSON.stringify({ type: 'user', sessionId: binding.nativeSessionId,
      uuid: `synthetic-receipt-${index}`, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n');
  }
  async function accept(messageId: string, index: number) {
    receipt(index);
    // A timer may already own command.pump's async transcript read. Wait for
    // its durable result instead of treating a concurrent no-op pump as done.
    for (let i = 0; i < 100; i++) {
      await commands.pump('B'); coordinator.pump();
      if (ownerStore.peerMessages.get(messageId).delivery.state === 'accepted') return;
      await delay(20);
    }
    assert.fail('matching synthetic native receipt was not reconciled');
  }
  t.after(async () => {
    sockets.forEach(socket => socket.terminate());
    coordinator.dispose(); commands.dispose();
    for (const gateway of gateways) await closeGateway(gateway);
    underlying.dispose(); ownerStore.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { ownerStore, commands, coordinator, writes, composer, accept, openGateway, closeGateway, connect, request, conversationId,
    prefix: `/api/conversations/${conversationId}`,
    busy() { commands.hook('B', { event: 'UserPromptSubmit', sessionId: binding.nativeSessionId }, ++hookSeq); },
    idle() { commands.hook('B', { event: 'Stop', sessionId: binding.nativeSessionId }, ++hookSeq); } };
}

test('busy and draft guards survive a real gateway replacement; HTTP retry still produces one native submission', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let gateway = await f.openGateway();
  f.busy();
  const input = { requestId: 'retry-across-gateways', text: 'one durable message' };
  const response = await f.request(gateway, f.prefix + '/inbox', input);
  assert.equal(response.status, 202); const saved = await response.json();
  f.coordinator.pump();
  assert.equal(f.ownerStore.peerMessages.get(saved.message.id).delivery.reason, 'busy');
  const oldRun = f.ownerStore.conversationRuns.active(f.conversationId)!;
  await f.closeGateway(gateway);
  f.idle(); f.composer('LOCAL_DRAFT');
  await until(() => f.commands.control('B').reason === 'terminal_draft', 'draft must settle while gateway is absent');
  f.coordinator.pump(); assert.equal(f.writes.length, 0);
  assert.equal(f.ownerStore.peerMessages.get(saved.message.id).delivery.reason, 'terminal_draft');
  gateway = await f.openGateway();
  const retried = await f.request(gateway, f.prefix + '/inbox', input);
  assert.equal(retried.status, 202); const duplicate = await retried.json();
  assert.equal(duplicate.message.id, saved.message.id); assert.equal(duplicate.delivery.id, saved.delivery.id);
  assert.equal(f.ownerStore.conversationRuns.active(f.conversationId)!.id, oldRun.id);
  f.composer(); await until(() => f.commands.control('B').reason === null, 'empty composer must settle');
  f.coordinator.pump(); await f.commands.pump('B');
  await until(() => f.writes.length === 1, 'one actual command-owner write');
  await f.accept(saved.message.id, 0);
  assert.equal(f.ownerStore.peerMessages.get(saved.message.id).delivery.state, 'accepted');
  const again = await (await f.request(gateway, f.prefix + '/inbox', input)).json();
  assert.equal(again.message.id, saved.message.id);
  f.coordinator.pump(); await f.commands.pump('B');
  assert.equal(f.writes.length, 1); assert.equal(f.ownerStore.aiCommands.list('B').items.length, 1);
  assert.equal((await (await f.request(gateway, f.prefix + '/inbox')).json()).items.length, 1);
});

test('acceptance committed while HTTP is offline is recovered by snapshot and subsequent WebSocket changes without duplicate delivery', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let gateway = await f.openGateway();
  const snapshot = await (await f.request(gateway, f.prefix + '/snapshot')).json();
  const stream = f.connect(gateway, snapshot.cursor);
  await stream.wait(frame => frame.type === 'changes');
  const input = { requestId: 'receipt-during-offline', text: 'receipt survives gateway loss' };
  const saved = await (await f.request(gateway, f.prefix + '/inbox', input)).json();
  await stream.wait(frame => frame.type === 'changes' && frame.items.some((item: any) => item.entityId === saved.message.id));
  f.coordinator.pump(); await f.commands.pump('B');
  await until(() => f.writes.length === 1, 'first native submission');
  const beforeCloseCursor = stream.frames.filter(frame => frame.type === 'changes').at(-1)!.cursor;
  const closed = once(stream.ws, 'close'); await f.closeGateway(gateway);
  assert.equal((await closed)[0], 1012, 'old gateway explicitly closes its stream');
  await f.accept(saved.message.id, 0);
  assert.equal(f.ownerStore.peerMessages.get(saved.message.id).delivery.state, 'accepted');
  gateway = await f.openGateway();
  const stale = await f.request(gateway, f.prefix + '/changes?cursor=' + encodeURIComponent(beforeCloseCursor));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'resync_required');
  const recovered = await (await f.request(gateway, f.prefix + '/snapshot')).json();
  assert.equal(recovered.inbox.items[0].message.id, saved.message.id);
  assert.equal(recovered.inbox.items[0].delivery.state, 'accepted');
  assert.equal(recovered.inbox.items[0].delivery.acceptedNativeMessageId, 'synthetic-receipt-0');
  const retried = await (await f.request(gateway, f.prefix + '/inbox', input)).json();
  assert.equal(retried.message.id, saved.message.id); assert.equal(f.writes.length, 1);
  f.busy();
  const next = await (await f.request(gateway, f.prefix + '/inbox', { requestId: 'snapshot-subscribe-gap', text: 'saved after snapshot' })).json();
  const reconnected = f.connect(gateway, recovered.cursor);
  const caught = await reconnected.wait(frame => frame.type === 'changes' && frame.items.some((item: any) => item.entityId === next.message.id));
  const cancellation = await f.request(gateway, '/api/peer-deliveries/' + next.delivery.id + '/cancel', {});
  assert.equal(cancellation.status, 200);
  await reconnected.wait(frame => frame.type === 'changes' && frame.items.some((item: any) => item.entityId === next.message.id && item.payload.deliveryId === next.delivery.id && item.payload.state === 'cancelled'));
  const changes = reconnected.frames.filter(frame => frame.type === 'changes').flatMap(frame => frame.items);
  assert.equal(new Set(changes.map(item => item.seq)).size, changes.length);
  assert.ok(changes.every(item => item.conversationId === f.conversationId));
  const polled = await (await f.request(gateway, f.prefix + '/changes?cursor=' + encodeURIComponent(caught.cursor))).json();
  assert.ok(polled.items.some((item: any) => item.entityId === next.message.id && item.payload.deliveryId === next.delivery.id && item.payload.state === 'cancelled'));
  f.coordinator.pump(); await f.commands.pump('B');
  assert.equal(f.writes.length, 1); assert.equal(f.ownerStore.aiCommands.list('B').items.length, 1);
});
