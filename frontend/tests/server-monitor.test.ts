import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMonitorPolling } from '../src/features/server-monitor/poll.ts';
import { bytes, percentage } from '../src/features/server-monitor/format.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
test('slow status requests remain single-flight and manual refresh coalesces', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0, resolve!: (n: number) => void;
  const values: number[] = [];
  const p = startMonitorPolling({ read: () => { reads++; return new Promise<number>(r => resolve = r); }, data: n => values.push(n), error() {} });
  t.after(p.dispose); await tick(); p.refresh(); p.refresh(); t.mock.timers.tick(10000); assert.equal(reads, 1);
  resolve(1); await tick(); assert.equal(reads, 2); assert.deepEqual(values, [1]);
});
test('hiding aborts the request, waking requests fresh data and old results cannot overwrite it', async t => {
  const flights: { signal: AbortSignal; resolve: (n: number) => void }[] = [], values: number[] = [];
  const p = startMonitorPolling({ read: signal => new Promise<number>(resolve => flights.push({ signal, resolve })), data: n => values.push(n), error() {} });
  t.after(p.dispose); await tick(); p.visible(false); assert.equal(flights[0].signal.aborted, true);
  p.visible(true); flights[0].resolve(1); await tick(); assert.equal(flights.length, 2); assert.deepEqual(values, []);
  flights[1].resolve(2); await tick(); assert.deepEqual(values, [2]);
});
test('unmount cancels polling and ignores a late result', async () => {
  let resolve!: (n: number) => void; const values: number[] = [];
  const p = startMonitorPolling({ read: () => new Promise<number>(r => resolve = r), data: n => values.push(n), error() {} });
  await tick(); p.dispose(); resolve(1); await tick(); assert.deepEqual(values, []);
});
test('missing measurements stay unknown and byte units remain consistent', () => {
  assert.equal(bytes(null), '—'); assert.equal(bytes(-1), '—'); assert.equal(bytes(1024 ** 3), '1.0 GiB'); assert.equal(bytes(0), '0 B'); assert.equal(percentage(null), '—'); assert.equal(percentage(10.25), '10.3%');
});
