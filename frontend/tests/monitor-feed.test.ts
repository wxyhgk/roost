import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMonitorFeed } from '../src/features/server-monitor/feed';
const tick = () => new Promise<void>(r => setImmediate(r));
test('footer readers share one summary feed; opening details upgrades it and closing returns to summaries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = []; let attached = 0;
  const feed = createMonitorFeed({ summary: async () => { calls.push('summary'); return { timestamp: calls.length } as never; }, detail: async () => { calls.push('detail'); return { timestamp: calls.length } as never; } }, {
    visible: () => true, subscribe: () => { attached++; return () => { attached--; }; },
  });
  const stopA = feed.subscribe(() => {}, 'summary'), stopB = feed.subscribe(() => {}, 'summary');
  await tick(); assert.deepEqual(calls, ['summary']); assert.equal(attached, 1);
  t.mock.timers.tick(5000); await tick(); assert.equal(calls.length, 1);
  const stopDetail = feed.subscribe(() => {}, 'detail');
  await tick(); assert.deepEqual(calls, ['summary', 'detail']); assert.equal(feed.getSnapshot().summary, feed.getSnapshot().detail);
  t.mock.timers.tick(5000); await tick(); assert.equal(calls.at(-1), 'detail');
  stopDetail(); await tick(); assert.equal(calls.at(-1), 'summary'); assert.equal(attached, 1);
  stopA(); stopB(); const end = calls.length; t.mock.timers.tick(30000); await tick(); assert.equal(calls.length, end); assert.equal(attached, 0);
});
test('hidden pages stop sampling and an aborted old mode cannot overwrite a newer snapshot', async () => {
  let visible = true, visibility = () => {};
  const requests: { kind: string; signal: AbortSignal; resolve(value: never): void }[] = [];
  const read = (kind: string) => (signal: AbortSignal) => new Promise<never>(resolve => requests.push({ kind, signal, resolve }));
  const feed = createMonitorFeed({ summary: read('summary'), detail: read('detail') }, { visible: () => visible, subscribe: (_wake, changed) => { visibility = changed; return () => {}; } });
  const stop = feed.subscribe(() => {}, 'summary'); await tick();
  const close = feed.subscribe(() => {}, 'detail'); await tick(); assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve({ timestamp: 2 } as never); await tick(); requests[0].resolve({ timestamp: 1 } as never); await tick();
  assert.equal(feed.getSnapshot().summary?.timestamp, 2);
  visible = false; visibility(); feed.refresh(); await tick(); assert.equal(requests.length, 2);
  visible = true; visibility(); await tick(); assert.equal(requests.length, 3);
  close(); stop(); assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve({ timestamp: 3 } as never); await tick(); assert.equal(feed.getSnapshot().summary?.timestamp, 2);
});
