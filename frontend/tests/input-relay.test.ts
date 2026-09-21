/*
  接线本身。

  `interrupt-guard.test.ts` 钉的是「这一下该拿它怎么办」，`local-echo.test.ts` 钉的是回显
  引擎；中间这一道——**决定出来之后到底发了什么、界面看到什么、回显赌了哪一串**——在搬进
  `inputRelay` 之前谁也测不到：它长在控制器一个匿名 IIFE 里的匿名回调里。

  这几条钉的都是「改坏了不会有人发现」的那种：替换成清空键之后还去预测用户按的 Ctrl+C，
  屏幕上就多一个永远等不到回声的幽灵字符；举起来之后忘了让它自己落下，「再按一次就打断」
  的提示会一直挂着，而守卫那边其实早就过期了。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputRelay } from '../src/features/terminal/session/inputRelay';
import { INTERRUPT_WINDOW_MS } from '../src/features/terminal/interruptGuard';

const CTRL_C = '\x03';
const CTRL_U = '\x15';

function harness(overrides: Partial<Parameters<typeof createInputRelay>[0]> = {}) {
  const sent: string[] = [], previewed: string[] = [], armedSeen: boolean[] = [];
  let cleared = 0, echoable = true, working = true, accepts = true;
  const fired: (() => void)[] = [];
  let handle = 0;
  const live = new Map<number, () => void>();
  const timers = {
    setTimeout(handler: () => void, ms: number) {
      assert.equal(ms, INTERRUPT_WINDOW_MS, '落下的时机必须和守卫的窗口同一个常量');
      const id = ++handle; live.set(id, handler); return id;
    },
    clearTimeout(id: unknown) { if (typeof id === 'number') live.delete(id); },
  };
  const relay = createInputRelay({
    send: data => { sent.push(data); return accepts; },
    echoable: () => echoable,
    terminal: () => ({ previewInput: d => previewed.push(d), clearLocalEcho: () => { cleared++; } }),
    context: () => ({ clearInputKey: CTRL_U, working }),
    armed: value => armedSeen.push(value),
    timers,
    ...overrides,
  });
  return {
    relay, sent, previewed, armedSeen, fired,
    get cleared() { return cleared; },
    set echoable(v: boolean) { echoable = v; },
    set working(v: boolean) { working = v; },
    set accepts(v: boolean) { accepts = v; },
    /** 让举着的那一下自己落下。 */
    expire() { const all = [...live.values()]; live.clear(); for (const fn of all) fn(); },
    pendingFalls: () => live.size,
  };
}

test('agent 在跑：第一下 Ctrl+C 发出去的是清空键，而且**不预测**它', () => {
  const h = harness();
  h.relay.press(CTRL_C);
  assert.deepEqual(h.sent, [CTRL_U], '发下去的是替换后的那一串');
  assert.deepEqual(h.previewed, [], '这一下根本没发给 PTY，预测它就是画一个永远等不到回声的字符');
  assert.equal(h.cleared, 1, '反过来要把之前的预测撤掉');
  assert.deepEqual(h.armedSeen.at(-1), true, '界面要知道现在举着「再按一次就打断」');
});

test('第二下才是真打断，而且打断本身会被预测（它确实发出去了）', () => {
  const h = harness();
  h.relay.press(CTRL_C);
  h.relay.press(CTRL_C);
  assert.deepEqual(h.sent, [CTRL_U, CTRL_C]);
  assert.deepEqual(h.previewed, [CTRL_C]);
  assert.equal(h.armedSeen.at(-1), false, '打断之后立刻落下');
});

test('举起来之后没人再按键，也要自己落下——armed 是看时间的，不会有人来问它', () => {
  const h = harness();
  h.relay.press(CTRL_C);
  assert.equal(h.pendingFalls(), 1);
  h.expire();
  assert.deepEqual(h.armedSeen, [true, false]);
});

test('举着的时候又按了别的键：上一个计时器要被取消，不能让它稍后把界面打回去', () => {
  const h = harness();
  h.relay.press(CTRL_C);
  h.relay.press('x');
  assert.equal(h.pendingFalls(), 0, '普通按键不举旗，所以不该留着计时器');
  assert.deepEqual(h.armedSeen, [true, false], '中间打了别的说明换了主意，当场落下');
});

test('普通输入原样发下去并预测；agent 没在跑时 Ctrl+C 也是普通输入', () => {
  const h = harness();
  h.working = false;
  h.relay.press(CTRL_C);
  assert.deepEqual(h.sent, [CTRL_C], '不是 agent 的时候 Ctrl+C 就该直接下去，慢半拍都不行');
  assert.deepEqual(h.previewed, [CTRL_C]);
});

test('没真发出去就不预测——半开的 socket 会返回假', () => {
  const h = harness();
  h.accepts = false;
  h.relay.press('a');
  assert.deepEqual(h.sent, ['a']);
  assert.deepEqual(h.previewed, [], '赌注的前提是这些字节真的在路上');
  assert.equal(h.cleared, 1);
});

test('后台/输入未开/shell 已死：发照发，但不赌回显', () => {
  const h = harness();
  h.echoable = false;
  h.relay.press('a');
  assert.deepEqual(h.sent, ['a']);
  assert.deepEqual(h.previewed, []);
});

test('终端还没挂上时不炸', () => {
  const h = harness({ terminal: () => null });
  h.relay.press('a');
  assert.deepEqual(h.sent, ['a']);
});

test('拆掉时要把在途的「落下」取消，否则它会打到已经死掉的会话上', () => {
  const h = harness();
  h.relay.press(CTRL_C);
  h.relay.dispose();
  assert.equal(h.pendingFalls(), 0);
});
