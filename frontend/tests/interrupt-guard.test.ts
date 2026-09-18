/*
  运行中的第一下 Ctrl+C 该清空输入，第二下才打断。

  每条边界都单独钉：这段逻辑挡在「用户按了打断」和「模型真的停下」中间，放宽一点
  就是该停的没停，收紧一点就是普通 shell 里的 Ctrl+C 慢了半拍。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterruptGuard, INTERRUPT_WINDOW_MS } from '../src/features/terminal/interruptGuard';

const CTRL_C = '\x03';
const CTRL_U = '\x15';
const agent = { clearInputKey: CTRL_U, working: true };
const clock = (start = 1000) => { let now = start; return { now: () => now, advance: (ms: number) => { now += ms; } }; };

test('agent 在跑：第一下清空输入，第二下才真打断', () => {
  const time = clock();
  const guard = createInterruptGuard(time.now);
  assert.deepEqual(guard.press(CTRL_C, agent), { kind: 'clear', data: CTRL_U });
  assert.equal(guard.armed(), true, '界面要能看出现在举着「再按一次」');
  assert.deepEqual(guard.press(CTRL_C, agent), { kind: 'interrupt' });
  assert.equal(guard.armed(), false, '打断之后就落下，下一次又从清空开始');
});

test('举着的那一下会过期：犹豫一秒半以上，再按还是清空', () => {
  const time = clock();
  const guard = createInterruptGuard(time.now);
  guard.press(CTRL_C, agent);
  time.advance(INTERRUPT_WINDOW_MS + 1);
  assert.equal(guard.armed(), false);
  assert.deepEqual(guard.press(CTRL_C, agent), { kind: 'clear', data: CTRL_U }, '攒着的按键不该等到下一次犹豫');
});

test('中间打了别的字就解除：那不是犹豫，是改了主意', () => {
  const guard = createInterruptGuard(clock().now);
  guard.press(CTRL_C, agent);
  assert.deepEqual(guard.press('a', agent), { kind: 'forward' });
  assert.equal(guard.armed(), false);
  assert.deepEqual(guard.press(CTRL_C, agent), { kind: 'clear', data: CTRL_U });
});

/* 普通 shell 会话一个字节都不碰：那里 Ctrl+C 慢一下，可能就是多跑了一段不该跑的。 */
test('agent 没在跑就不拦', () => {
  const guard = createInterruptGuard(clock().now);
  assert.deepEqual(guard.press(CTRL_C, { clearInputKey: CTRL_U, working: false }), { kind: 'forward' });
  assert.equal(guard.armed(), false, '没拦就不该举起来，否则下一下会被当成确认');
});

/* 猜一个清空键的代价不对称：猜错了是往正在跑的 agent 里塞一个不知道会触发什么的控制字符。 */
test('没量过清空键的 CLI 不拦', () => {
  const guard = createInterruptGuard(clock().now);
  assert.deepEqual(guard.press(CTRL_C, { clearInputKey: null, working: true }), { kind: 'forward' });
  assert.equal(guard.armed(), false);
});

/*
  粘贴进来的一大段里也可能含 0x03。那是数据不是按键——替换它等于悄悄改写用户粘的内容。
*/
test('只认单独一下 Ctrl+C，粘贴里夹着的 0x03 原样送过去', () => {
  const guard = createInterruptGuard(clock().now);
  assert.deepEqual(guard.press(`echo hi${CTRL_C}`, agent), { kind: 'forward' });
  assert.equal(guard.armed(), false);
});

test('举着的时候，即使 agent 已经不在跑了，第二下也要真的打断', () => {
  // 第一下之后那一轮正好结束：此刻放行才对——用户看到的提示就是「再按一次打断」，
  // 按了却什么都不发，比多停一次糟得多。
  const guard = createInterruptGuard(clock().now);
  guard.press(CTRL_C, agent);
  assert.deepEqual(guard.press(CTRL_C, { clearInputKey: CTRL_U, working: false }), { kind: 'interrupt' });
});
