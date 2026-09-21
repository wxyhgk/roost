/*
  终端查找的节流。

  xterm 的查找在未命中时会扫整个缓冲区（20000 行 × 140 列约 280 万字符），而它的行缓存
  被活着的终端不停清掉，逐键之间拿不到复用。所以「每敲一个字符搜一次」在真实的回滚区上
  是每个字符卡一下——而那几次中间结果谁也不看。

  下面每一条都是这个模块存在的理由，不是它的实现细节。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchScheduler, TYPING_PAUSE_MS } from '../src/features/terminal/view/searchScheduler';

/** 手动推进的假定时器：不用等真实时间，也不会因为机器忙而抖。 */
function fakeTimers() {
  let seq = 0;
  const jobs = new Map<number, () => void>();
  return {
    api: {
      setTimeout(handler: () => void) { jobs.set(++seq, handler); return seq; },
      clearTimeout(handle: unknown) { jobs.delete(handle as number); },
    },
    pending: () => jobs.size,
    fire() { const all = [...jobs.values()]; jobs.clear(); for (const job of all) job(); },
  };
}

function setup() {
  const timers = fakeTimers();
  const searches: [string, number][] = [];
  let pending = 0;
  const scheduler = createSearchScheduler({
    search: (query, direction) => { searches.push([query, direction]); },
    onPending: () => { pending++; },
    timers: timers.api,
  });
  return { scheduler, timers, searches, pendingCount: () => pending };
}

test('连打只搜一次 —— 中间那几次结果谁也不看，却每次都要扫满缓冲区', () => {
  const f = setup();
  for (const q of ['z', 'zz', 'zzz', 'zzzz']) f.scheduler.type(q);
  assert.deepEqual(f.searches, [], '停下来之前一次都不该搜');
  assert.equal(f.timers.pending(), 1, '前面几次必须被取消掉，不是排队');
  f.timers.fire();
  assert.deepEqual(f.searches, [['zzzz', 1]], '只搜最后那一个词');
});

/* 回车和上下箭头是「现在就要结果」，等待只会碍事。 */
test('回车和上下箭头不等，而且会把攒着的那次顶掉', () => {
  const f = setup();
  f.scheduler.type('abc');
  f.scheduler.now('abc', -1);
  assert.deepEqual(f.searches, [['abc', -1]], '立刻搜，方向也要带对');
  assert.equal(f.timers.pending(), 0, '攒着的那次已经没有意义了');
  f.timers.fire();
  assert.deepEqual(f.searches, [['abc', -1]], '不该再搜第二遍');
});

/* 清除是常数时间的，等它没有意义；而留着上一次的高亮会让人以为还在搜。 */
test('清空立刻生效，不攒', () => {
  const f = setup();
  f.scheduler.type('');
  assert.deepEqual(f.searches, [['', 1]]);
  assert.equal(f.timers.pending(), 0);
});

/*
  关掉查找栏之后那一次要是还触发，高亮会被重新画回来——人已经离开了，屏幕却自己变了。
*/
test('取消之后攒着的那次不会再触发', () => {
  const f = setup();
  f.scheduler.type('abc');
  f.scheduler.cancel();
  f.timers.fire();
  assert.deepEqual(f.searches, []);
});

/*
  词变了，上一次的「未找到」对它就不成立了。不先收掉的话，正在打一个能找到的词时，
  屏幕上会挂着上一个字符的红字。
*/
test('攒的时候先报一声，好让界面把上一次的「未找到」收掉', () => {
  const f = setup();
  f.scheduler.type('a');
  f.scheduler.type('ab');
  assert.equal(f.pendingCount(), 2, '每一次打字都要报');
  f.scheduler.type('');
  assert.equal(f.pendingCount(), 2, '清空不算「正在等」——它当场就搜完了');
});

test('等待时长有个说法，不是随手写的数', () => {
  assert.ok(TYPING_PAUSE_MS >= 60 && TYPING_PAUSE_MS <= 250,
    '太短挡不住连打，太长会让人觉得没反应');
});
