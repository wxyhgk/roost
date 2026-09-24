import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMonitorFeed } from '../src/features/server-monitor/feed';
const tick = () => new Promise<void>(r => setImmediate(r));
/*
  detail 那一档的响应现在要过一遍 `sampleHistory`（曲线归 feed 了），所以假快照不能再是
  光一个 timestamp——得带上它真正读的那几格，否则整个响应会被当成一次失败的轮询。
*/
const snapshot = (timestamp: number, usage: number | null = null) => ({
  timestamp, host: { hostname: 'host' },
  cpu: { status: 'ok', sampledAt: timestamp, data: usage == null ? null : { usage } },
  memory: { status: 'ok', sampledAt: timestamp, data: null },
  network: { status: 'ok', sampledAt: timestamp, data: null },
} as never);
test('footer readers share one summary feed; opening details upgrades it and closing returns to summaries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = []; let attached = 0;
  const feed = createMonitorFeed({ summary: async () => { calls.push('summary'); return snapshot(calls.length); }, detail: async () => { calls.push('detail'); return snapshot(calls.length); } }, {
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
  requests[1].resolve(snapshot(2)); await tick(); requests[0].resolve(snapshot(1)); await tick();
  assert.equal(feed.getSnapshot().summary?.timestamp, 2);
  visible = false; visibility(); feed.refresh(); await tick(); assert.equal(requests.length, 2);
  visible = true; visibility(); await tick(); assert.equal(requests.length, 3);
  close(); stop(); assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve(snapshot(3)); await tick(); assert.equal(feed.getSnapshot().summary?.timestamp, 2);
});
test('trend samples live on the feed, so a panel that unmounts and comes back keeps its curve', async () => {
  /*
    钉住「切个面板曲线就清零」那个缺陷：采样点原来是 ServerMonitorView 里的 useState，
    而右面板整块挂着 key={rightView}，换视图就重建组件——数据源没断，曲线却从零开始。
  */
  const resolvers: ((value: never) => void)[] = [];
  const read = () => new Promise<never>(resolve => { resolvers.push(resolve); });
  const feed = createMonitorFeed({ summary: read, detail: read }, { visible: () => true, subscribe: () => () => {} });
  const panel = feed.subscribe(() => {}, 'detail'); await tick();
  resolvers[0](snapshot(1000, 10)); await tick();
  assert.deepEqual(feed.getSnapshot().history.cpu.points, [{ at: 1000, value: 10 }]);
  panel(); // 组件卸载
  const again = feed.subscribe(() => {}, 'detail'); await tick();
  resolvers[1](snapshot(6000, 20)); await tick();
  assert.deepEqual(feed.getSnapshot().history.cpu.points, [{ at: 1000, value: 10 }, { at: 6000, value: 20 }]);
  again();
  // 只剩页脚那个摘要读者时曲线不动，也不清零：摘要里没有采样时刻可加。
  const footer = feed.subscribe(() => {}, 'summary'); await tick();
  resolvers[2](snapshot(11000, 30)); await tick();
  assert.deepEqual(feed.getSnapshot().history.cpu.points, [{ at: 1000, value: 10 }, { at: 6000, value: 20 }]);
  footer();
});
