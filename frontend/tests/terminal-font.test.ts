import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_FONT_FAMILY, observeFonts, waitForMeasurable } from '../src/features/terminal/engine/font';

const tick = () => new Promise<void>(r => setImmediate(r));
const sized = { clientWidth: 1066, clientHeight: 842 } as HTMLElement;

function fakeFonts() {
  let settleLoad!: () => void, settleReady!: () => void;
  const listeners = new Set<() => void>();
  const fonts = {
    load: () => new Promise<void>(r => { settleLoad = r; }),
    ready: new Promise<void>(r => { settleReady = r; }),
    addEventListener: (_type: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn); },
  };
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { fonts };
  return { listeners,
    arrive: () => { settleLoad(); settleReady(); },
    restore: () => { (globalThis as { document?: unknown }).document = previous; } };
}

/*
  字体是测量的输入，和容器尺寸平级。

  终端字体走 `display=swap`：先用回退字体渲染，字体到了再换掉，而换掉那一下格子高度
  就变了。抢在那之前量，行数会偏大；等恢复的画面写进去之后才被改小，而 **xterm 缩行
  时丢的是光标下面的行**——序列化恢复恰好把光标放在 AI CLI 的输入框里，于是输入框
  下半截被吃掉，而且那次改小发给 PTY 的尺寸和它已有的相同，不产生 SIGWINCH，
  TUI 永远不知道要重画。见 issues/2026-09-10-restore-loses-rows-below-cursor.md。
*/
test('a terminal is not measurable until the web font has settled', async () => {
  const fonts = fakeFonts();
  try {
    let ready = false;
    void waitForMeasurable(sized).then(() => { ready = true; });
    await tick();
    assert.equal(ready, false, 'measuring before the font swaps produces a row count that is about to change');
    fonts.arrive();
    await tick();
    assert.equal(ready, true);
  } finally { fonts.restore(); }
});

/* 字体 CDN 挂掉只该让字变丑，不该让终端起不来。 */
test('a font that never arrives still lets the terminal start', async (t) => {
  const fonts = fakeFonts();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let ready = false;
    void waitForMeasurable(sized).then(() => { ready = true; });
    await tick();
    assert.equal(ready, false);
    t.mock.timers.tick(2000);
    await tick();
    assert.equal(ready, true, 'the wait must be bounded');
  } finally { fonts.restore(); }
});

/* 一个已经放弃等待的挂载不该被吊在那儿。 */
test('an aborted mount stops waiting for the font', async () => {
  const fonts = fakeFonts();
  try {
    const abort = new AbortController();
    let ready = false;
    void waitForMeasurable(sized, abort.signal).then(() => { ready = true; });
    await tick();
    assert.equal(ready, false);
    abort.abort();
    await tick();
    assert.equal(ready, true);
  } finally { fonts.restore(); }
});

/*
  字体晚到时，容器一个像素都没变，ResizeObserver 不会响——只有这条订阅能发现，
  而那一次重新测量会连 PTY 的尺寸一起改，所以 TUI 会收到 SIGWINCH 并自愈。
*/
test('a late font arrival is observable, and unsubscribing releases it', () => {
  const fonts = fakeFonts();
  try {
    let refits = 0;
    const stop = observeFonts(() => { refits++; });
    assert.equal(fonts.listeners.size, 1);
    for (const fn of fonts.listeners) fn();
    assert.equal(refits, 1);
    stop();
    assert.equal(fonts.listeners.size, 0);
  } finally { fonts.restore(); }
});

/* 没有 document 的宿主（测试、SSR）不该炸，也不该假装订阅成功。 */
test('a host without a font registry degrades instead of throwing', async () => {
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = undefined;
  try {
    await waitForMeasurable(sized);
    assert.doesNotThrow(() => observeFonts(() => {})());
  } finally { (globalThis as { document?: unknown }).document = previous; }
});

/*
  Windows 上「每个字母之间空一大格」的那次回归：栈是
  `"IBM Plex Mono", ui-monospace, "PingFang SC", "Microsoft YaHei", …`，而这三个在
  Windows 上**一个都拿不到**——IBM Plex Mono 走 Google Fonts（桌面版 CSP 直接挡掉），
  ui-monospace 只有 macOS 认，PingFang SC 是 macOS 独有。于是第一个能用的是微软雅黑，
  一个比例字体，拉丁字形比 xterm 的格子窄。

  钉的是**顺序**不是具体字体：CJK 家族之前必须先有一个该平台真正的等宽字体。
*/
test('every CJK fallback sits behind a real monospace family', () => {
  const families = TERMINAL_FONT_FAMILY.split(',').map(f => f.trim().replaceAll('"', ''));
  const cjk = ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC'];
  // 各平台至少一个自带等宽字体，必须排在所有 CJK 家族之前。
  for (const [platform, mono] of [['Windows', 'Consolas'], ['macOS', 'ui-monospace'], ['Linux', 'DejaVu Sans Mono']]) {
    const at = families.indexOf(mono);
    assert.ok(at >= 0, `${platform} 没有等宽字体兜底：栈里找不到 ${mono}`);
    for (const name of cjk) {
      const cjkAt = families.indexOf(name);
      if (cjkAt >= 0) assert.ok(at < cjkAt, `${mono} 必须排在 ${name} 前面，否则 ${platform} 上拉丁字形会用比例字体画`);
    }
  }
  assert.equal(families.at(-1), 'monospace', '通用 monospace 收尾');
});
