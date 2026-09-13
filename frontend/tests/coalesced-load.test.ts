import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoalescedLoad } from '../src/features/files/coalescedLoad.ts';

/** 手动控制何时完成的假请求，用来精确摆出「在途期间又来了刷新」的时序。 */
function controllable() {
  const calls: { signal: AbortSignal; resolve(v: string[]): void; reject(e: unknown): void }[] = [];
  const run = (signal: AbortSignal) => new Promise<string[]>((resolve, reject) => {
    calls.push({ signal, resolve, reject });
  });
  return { run, calls };
}
const collect = () => {
  const data: string[][] = [], errors: unknown[] = [];
  let starts = 0, settles = 0;
  return {
    data, errors,
    get starts() { return starts; },
    get settles() { return settles; },
    on: {
      start: () => { starts++; },
      data: (v: string[]) => { data.push(v); },
      error: (e: unknown) => { errors.push(e); },
      settled: () => { settles++; },
    },
  };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test('在途期间的刷新不打断它，等它回来再取一次', async () => {
  const { run, calls } = controllable();
  const sink = collect();
  const feed = createCoalescedLoad(run, sink.on);

  feed.load();
  assert.equal(calls.length, 1);

  feed.load();                       // 在途时再要一次
  assert.equal(calls.length, 1, '不该并发发起第二个请求');
  assert.equal(calls[0].signal.aborted, false, '**更不该打断第一个**');

  calls[0].resolve(['a']);
  await tick();
  assert.deepEqual(sink.data, [['a']], '第一次的结果照样交付');
  assert.equal(calls.length, 2, '回来之后补取排队的那一次');

  calls[1].resolve(['b']);
  await tick();
  assert.deepEqual(sink.data, [['a'], ['b']]);
  feed.dispose();
});

test('在途期间来多少次刷新都只补一次', async () => {
  const { run, calls } = controllable();
  const sink = collect();
  const feed = createCoalescedLoad(run, sink.on);

  feed.load();
  for (let i = 0; i < 20; i++) feed.load();
  assert.equal(calls.length, 1);

  calls[0].resolve(['x']);
  await tick();
  assert.equal(calls.length, 2, '20 次刷新合并成 1 次补取');

  calls[1].resolve(['y']);
  await tick();
  assert.equal(calls.length, 2, '补取回来之后不再自己续上');
  feed.dispose();
});

/*
  「结束」要等这一批真的空了才报。

  界面拿它关「加载中」。补取期间就报结束的话，会先关掉再打开，闪一下。
*/
test('还有排队时不报结束', async () => {
  const { run, calls } = controllable();
  const sink = collect();
  const feed = createCoalescedLoad(run, sink.on);

  feed.load();
  feed.load();
  calls[0].resolve(['a']);
  await tick();
  assert.equal(sink.settles, 0, '排队的还没取，这一批没完');
  assert.equal(sink.starts, 2);

  calls[1].resolve(['b']);
  await tick();
  assert.equal(sink.settles, 1);
  feed.dispose();
});

test('失败也算一次结束，并且不会卡住后续的刷新', async () => {
  const { run, calls } = controllable();
  const sink = collect();
  const feed = createCoalescedLoad(run, sink.on);

  feed.load();
  calls[0].reject(new Error('offline'));
  await tick();
  assert.equal(sink.errors.length, 1);
  assert.equal(sink.settles, 1);

  feed.load();
  assert.equal(calls.length, 2, '失败之后还能继续取');
  calls[1].resolve(['ok']);
  await tick();
  assert.deepEqual(sink.data, [['ok']]);
  feed.dispose();
});

test('dispose 中止在途请求，之后任何回调都不再发生', async () => {
  const { run, calls } = controllable();
  const sink = collect();
  const feed = createCoalescedLoad(run, sink.on);

  feed.load();
  feed.load();                       // 排着一次
  feed.dispose();
  assert.equal(calls[0].signal.aborted, true, '在途的要真的被中止');

  calls[0].resolve(['late']);        // 迟到的结果
  await tick();
  assert.deepEqual(sink.data, [], '作废之后不该再交付数据');
  assert.equal(calls.length, 1, '排队的那次也不该再发出去');
  assert.equal(sink.settles, 0);

  feed.load();
  assert.equal(calls.length, 1, 'dispose 之后 load() 是空操作');
});

test('dispose 可以重复调用', () => {
  const { run } = controllable();
  const feed = createCoalescedLoad(run, collect().on);
  feed.dispose();
  assert.doesNotThrow(() => feed.dispose());
});
