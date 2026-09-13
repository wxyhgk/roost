import test from 'node:test';
import assert from 'node:assert/strict';
import { watchTerminalConversation, matchesTerminalIdentity } from '../src/features/conversations/terminalIdentity';
import type { VerifiedRuntime } from '../src/shared/api/conversations';
const runtime: VerifiedRuntime = { conversationId: 'omp-history', runId: 'run', webSessionId: 'shell', terminalInstanceId: 'pty', generation: 'g', cliId: 'omp', nativeSessionId: 'native', runtimeVerified: true };
const identity = { instanceId: 'pty', cliId: 'omp', nativeSessionId: 'native' };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
test('same PTY and same native string do not make a previous CLI current', () => {
  assert.equal(matchesTerminalIdentity(runtime, 'shell', identity), true);
  for (const changed of [{ cliId: 'claude' }, { terminalInstanceId: 'old' }, { nativeSessionId: 'old' }, { webSessionId: 'other' }])
    assert.equal(matchesTerminalIdentity({ ...runtime, ...changed }, 'shell', identity), false);
});
test('CLI switch discards late previous lookup and retries until the new binding is verified', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates: unknown[] = [];
  let resolve!: (value: VerifiedRuntime) => void;
  const stopOld = watchTerminalConversation({ terminalId: 'shell', identity: { ...identity, cliId: 'claude' }, fetchCurrent: () => new Promise(r => { resolve = r; }), fetchHistory: async () => 'old', changed: (...value) => updates.push(value) });
  stopOld();
  let requests = 0;
  const stopNew = watchTerminalConversation({ terminalId: 'shell', identity, fetchCurrent: async () => { if (++requests === 1) throw new Error('409 binding pending'); return runtime; }, fetchHistory: async () => 'old-history', changed: (...value) => updates.push(value) });
  t.after(stopNew);
  resolve({ ...runtime, cliId: 'claude', conversationId: 'old' }); await flush();
  assert.deepEqual(updates, [['old-history', false]]);
  t.mock.timers.tick(1500); await flush();
  assert.deepEqual(updates, [['old-history', false], ['omp-history', true]]);
  stopNew(); t.mock.timers.tick(3000); await flush(); assert.equal(requests, 2);
});
test('an idle shell can read its last history but cannot claim a live identity', async t => {
  const updates: unknown[] = [];
  const stop = watchTerminalConversation({ terminalId: 'shell', identity: { ...identity, cliId: null }, fetchCurrent: async () => { throw new Error('unexpected current query'); }, fetchHistory: async () => 'claude-history', changed: (...value) => updates.push(value) });
  t.after(stop); await flush(); assert.deepEqual(updates, [['claude-history', false]]);
});
