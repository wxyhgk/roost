import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStatusStore, parseStatusFrame, type StatusEntry } from '../src/features/session-status/store';
import { connectSessionStatus } from '../src/features/session-status/connection';
const entry = (outputSeq = 10, overrides: Partial<StatusEntry> = {}): StatusEntry => ({ id: 's', instanceId: 'i', cliId: 'custom', state: 'active', outputSeq, lastOutputAt: 123, ...overrides });
const frame = (revision = 1, sessions = [entry()], monitorId = 'm') => ({ type: 'session-status', monitorId, revision, quietAfterMs: 3000, sessions });

test('full status snapshots remove absent sessions, ignore old revisions and keep heartbeat snapshots stable', () => {
  const s = createSessionStatusStore(); let updates = 0;
  s.subscribe('s', () => updates++);
  assert.equal(s.accept(frame()), true);
  const first = s.read('s');
  s.accept(frame(1, [entry(99, { state: 'exited' })]));
  assert.equal(s.read('s'), first); assert.equal(updates, 1);
  assert.equal(s.accept(frame(0)), false);
  s.accept(frame(2, [])); assert.equal(s.read('s').state, 'unknown');
  assert.deepEqual(s.serialize(), []);
});
test('unread survives reload and quiet/exit, while a changed monitor or instance establishes a fresh baseline', () => {
  let s = createSessionStatusStore();
  s.accept(frame()); assert.equal(s.read('s').unread, false);
  s.accept(frame(2, [entry(11, { state: 'quiet' })])); assert.equal(s.read('s').unread, true);
  s = createSessionStatusStore(s.serialize()); s.accept(frame(2, [entry(11)]));
  assert.equal(s.read('s').unread, true);
  s.presented('s', 'wrong', 11); assert.equal(s.read('s').unread, true);
  s.presented('s', 'i', 11); assert.equal(s.read('s').unread, false);
  s.accept(frame(3, [entry(12, { state: 'exited' })])); assert.equal(s.read('s').unread, true);
  s.accept(frame(1, [entry(30)], 'new-monitor')); assert.equal(s.read('s').unread, false);
  s.accept(frame(2, [entry(1, { instanceId: 'new-instance' })], 'new-monitor')); assert.equal(s.read('s').unread, false);
});
test('rendered cursor ahead of the status feed is retained; sequence alone does not rerender a row', () => {
  const s = createSessionStatusStore(); s.accept(frame());
  s.presented('s', 'i', 20); const first = s.read('s');
  s.accept(frame(2, [entry(15)])); assert.equal(s.read('s'), first);
  s.accept(frame(3, [entry(21)])); assert.equal(s.read('s').unread, true);
});
test('terminal rendered before the first status snapshot is not later marked unread', () => {
  const s = createSessionStatusStore([['s', { monitorId: 'm', instanceId: 'i', outputSeq: 5 }]]);
  s.presented('s', 'i', 20);
  s.accept(frame(1, [entry(10)]));
  s.accept(frame(2, [entry(20)])); assert.equal(s.read('s').unread, false);
  s.accept(frame(3, [entry(21)])); assert.equal(s.read('s').unread, true);
});
test('disconnect suppresses stale active status; equal-revision heartbeat can restore health', () => {
  const s = createSessionStatusStore(); s.accept(frame()); s.disconnect();
  assert.equal(s.read('s').state, 'disconnected');
  s.presented('s', 'i', 99); // do not acknowledge against a stale monitor
  s.accept(frame()); assert.equal(s.read('s').state, 'active');
  s.accept(frame(2, [entry(11, { state: 'unavailable' })]));
  assert.equal(s.read('s').state, 'unavailable'); assert.equal(s.read('s').unread, true);
});
test('invalid snapshots and saved cursors cannot poison state', () => {
  for (const value of [null, {}, frame(1, [entry(-1)]), frame(1, [entry(), entry()]), frame(-1)]) assert.equal(parseStatusFrame(value), null);
  const s = createSessionStatusStore([['s', { monitorId: 'm', instanceId: 'i', outputSeq: -100 }], null]);
  s.accept(frame()); assert.equal(s.read('s').unread, false);
});
test('read-only connection expires after 45 seconds, reconnects and ignores obsolete socket events', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    closed = false; onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor(public url: string) { sockets.push(this); }
    close() { this.closed = true; this.onclose?.(); }
    send() { throw new Error('status feed must remain read-only'); }
    receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const before = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'WebSocket', before); else Reflect.deleteProperty(globalThis, 'WebSocket'); });
  const s = createSessionStatusStore(), stop = connectSessionStatus('ws://fixture/api/session-status', s);
  sockets[0].receive(frame());
  t.mock.timers.tick(30000); sockets[0].receive(frame());
  t.mock.timers.tick(44999); assert.equal(s.read('s').state, 'active');
  t.mock.timers.tick(1); assert.equal(s.read('s').state, 'disconnected'); assert.equal(sockets[0].closed, true);
  t.mock.timers.tick(500); assert.equal(sockets.length, 2);
  sockets[1].receive(frame(1, [entry()], 'm2'));
  sockets[0].receive(frame(99, [entry(99, { state: 'exited' })])); assert.equal(s.read('s').state, 'active');
  stop(); t.mock.timers.tick(60000); assert.equal(sockets.length, 2);
});

test('identity-only changes notify consumers without requiring output or activity changes', () => {
  const s = createSessionStatusStore();
  const agent = { state: 'idle' as const, name: 'claude', agentSessionId: 'first', since: 10, waitingFor: null, summary: null, toolName: null, toolInputPreview: null };
  let updates = 0; s.subscribe('s', () => updates++);
  s.accept(frame(1, [entry(10, { agent })]));
  s.accept(frame(2, [entry(10, { agent: { ...agent, agentSessionId: 'second' } })]));
  assert.equal(s.read('s').agent?.agentSessionId, 'second'); assert.equal(updates, 2);
  s.accept(frame(3, [entry(10, { instanceId: 'replacement', agent: { ...agent, agentSessionId: 'second' } })]));
  assert.equal(s.read('s').instanceId, 'replacement'); assert.equal(updates, 3);
});
