import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecTracker } from "../src/features/terminal/engine/dec";
import { attachHostWheel, encodeTuiWheel, wheelTicks } from "../src/features/terminal/engine/wheel";
import { createResume } from "../src/features/terminal/session/resume";

function scroll(tracker: ReturnType<typeof createDecTracker>, deltaY = 80) {
  return encodeTuiWheel({
    mouseTracking: tracker.mouseTracking(), altScreen: tracker.altScreen(),
    col: 3, row: 4, deltaY, ticks: 2,
  });
}

test("reset clears old TUI mouse modes and partial escape sequences for a plain shell", () => {
  const tracker = createDecTracker();
  tracker.absorb("\x1b[?1049;1003;1006hOLD TUI\x1b[?100");
  assert.equal(tracker.mouseTracking(), true);
  tracker.reset();
  tracker.absorb("3h\nnew shell> ");
  assert.equal(tracker.mouseTracking(), false);
  assert.equal(tracker.sgrMouse(), false);
  assert.equal(tracker.altScreen(), false);
  assert.equal(scroll(tracker), null);
  assert.equal(scroll(tracker, -80), null);
});

test("split TUI enable sequences produce mouse wheel reports in both directions", () => {
  const tracker = createDecTracker();
  tracker.absorb("\x1b[?1049;100");
  tracker.absorb(new TextEncoder().encode("0;1006h"));
  assert.equal(tracker.mouseTracking(), true);
  assert.equal(tracker.sgrMouse(), true);
  assert.equal(scroll(tracker), "\x1b[<65;3;4M\x1b[<65;3;4M");
  assert.equal(scroll(tracker, -80), "\x1b[<64;3;4M\x1b[<64;3;4M");
});

test("leaving mouse mode falls back to alternate-screen arrows, then native shell scrolling", () => {
  const tracker = createDecTracker();
  tracker.absorb("\x1b[?1049;1000;1006h");
  tracker.absorb("\x1b[?1000;1006l");
  assert.equal(scroll(tracker), "\x1b[B\x1b[B");
  assert.equal(scroll(tracker, -80), "\x1b[A\x1b[A");
  tracker.absorb("\x1b[?1049l");
  assert.equal(scroll(tracker), null);
});

test("client replay reset clears inherited modes; new TUI output can enable its own modes", async () => {
  const tracker = createDecTracker();
  const resume = createResume({
    reset() { tracker.reset(); },
    write(data, done) { tracker.absorb(data); done(); },
    snapshot() { return null; },
  });
  await resume.prepare("old", null);
  await resume.accept({ type: "replay", instanceId: "old", seq: 1, data: "\x1b[?1049;1003;1006h" }).done;
  assert.notEqual(scroll(tracker), null);
  await resume.prepare("new", null);
  await resume.accept({ type: "replay", instanceId: "new", seq: 0, data: "shell> " }).done;
  assert.equal(scroll(tracker), null);
  await resume.accept({ type: "output", instanceId: "new", seq: 1, data: "\x1b[?1049;1000;1006hNEW TUI" }).done;
  assert.equal(tracker.modes.has(1003), false);
  assert.equal(tracker.modes.has(1000), true);
  assert.equal(scroll(tracker), "\x1b[<65;3;4M\x1b[<65;3;4M");
});


// jsdom 不一定给这些常量，按 DOM 规范固定值来。
const PIXEL = 0, LINE = 1, PAGE = 2;
const wheel = (deltaY: number, deltaMode = PIXEL) => ({ deltaY, deltaMode }) as WheelEvent;

test("触控板的细碎像素事件要攒够一行才滚，攒不够时返回 0 而不是 1", () => {
  const cellHeight = 20;
  // 一次轻扫发十几个 deltaY≈2 的事件。逐个向上取整就会滚十几行。
  let carry = 0, ticks = 0;
  for (let i = 0; i < 12; i++) {
    const result = wheelTicks(wheel(2), cellHeight, carry);
    carry = result.carry;
    ticks += result.ticks;
  }
  // 2px * 0.3 阻尼 / 20px 每行 = 0.03 行/次，12 次总共 0.36 行——一行都不该滚。
  assert.equal(ticks, 0, "轻扫不该滚出行来");

  // 但余数不能丢：继续扫下去必须累积成真的滚动。
  for (let i = 0; i < 100; i++) {
    const result = wheelTicks(wheel(2), cellHeight, carry);
    carry = result.carry;
    ticks += result.ticks;
  }
  assert.equal(ticks, 3, "112 次 × 0.03 行 ≈ 3.36 行");
});

test("整格的鼠标滚轮一次就滚，方向与行模式都保留", () => {
  const cellHeight = 20;
  // 传统鼠标一格 100px，超过 50 不算触控板，不打阻尼：100/20 = 5 行。
  assert.equal(wheelTicks(wheel(100), cellHeight).ticks, 5);
  assert.equal(wheelTicks(wheel(-100), cellHeight).ticks, -5);
  // 行模式和页模式不走像素累积。
  assert.equal(wheelTicks(wheel(3, LINE), cellHeight).ticks, 3);
  assert.equal(wheelTicks(wheel(-1, PAGE), cellHeight).ticks, -8);
  // 每格高度量不出来时退回近似值，不能变成不滚。
  assert.notEqual(wheelTicks(wheel(100), 0).ticks, 0);
  assert.equal(wheelTicks(wheel(0), cellHeight).ticks, 0);
});

test("换方向时余数跟着反向消耗，不会凭空多滚一行", () => {
  const cellHeight = 20;
  // 先向下攒一点余数。
  const down = wheelTicks(wheel(40), cellHeight);
  assert.equal(down.ticks, 0);
  assert.ok(down.carry > 0);
  // 立刻反向：新的量要和已攒的余数抵消，而不是各自独立向上取整。
  const up = wheelTicks(wheel(-40), cellHeight, down.carry);
  assert.equal(up.ticks, 0, "抵消后不该滚出行来");
  assert.ok(Math.abs(up.carry) < 1e-9);
});

test("不足一行时不发序列；够一行才按行数重复", () => {
  const base = { mouseTracking: true, altScreen: false, col: 3, row: 4, deltaY: 40 };
  assert.equal(encodeTuiWheel({ ...base, ticks: 0 }), null, "0 行必须什么都不发");
  assert.equal(encodeTuiWheel({ ...base, ticks: 0.6 }), null, "半行也不发");
  assert.equal(encodeTuiWheel({ ...base, ticks: 2 }), "\x1b[<65;3;4M\x1b[<65;3;4M");
  // 方向仍由 deltaY 决定，ticks 只提供数量，负数按绝对值算。
  assert.equal(encodeTuiWheel({ ...base, deltaY: -40, ticks: -2 }), "\x1b[<64;3;4M\x1b[<64;3;4M");
});

/*
  自绘光标的 TUI（claude、omp）会先 `?25l` 把硬件光标藏起来，再在自己想要的位置画一个。
  这时硬件光标停在哪没有意义，输入法的候选框不能跟着它走。

  **默认是可见**，所以「从没提过」和「被藏起来了」必须分得开——前者在 DEC 模式集合里
  长得一样（都是「不在集合里」），而两者的结论正好相反，所以这一条单独记。
*/
test("cursor visibility defaults to shown and tracks DECTCEM both ways", () => {
  const tracker = createDecTracker();
  assert.equal(tracker.cursorVisible(), true, "从没提过 = 可见");
  tracker.absorb("\x1b[?25l");
  assert.equal(tracker.cursorVisible(), false);
  tracker.absorb("\x1b[?25h");
  assert.equal(tracker.cursorVisible(), true);
  tracker.absorb("\x1b[?25l");
  tracker.reset();
  assert.equal(tracker.cursorVisible(), true, "重置回默认，而不是留在藏起来的状态");
});

/* 一条序列里混着多个模式时，25 不该被当成普通的被跟踪模式吞掉。 */
test("DECTCEM inside a combined sequence does not disturb the other modes", () => {
  const tracker = createDecTracker();
  tracker.absorb("\x1b[?1049;25l");
  assert.equal(tracker.cursorVisible(), false);
  assert.equal(tracker.altScreen(), false, "1049l 是退出备用屏幕");
  tracker.absorb("\x1b[?1049;25h");
  assert.equal(tracker.cursorVisible(), true);
  assert.equal(tracker.altScreen(), true);
});


/*
  转发给 TUI 的那条路径不打 0.3 阻尼。

  实测：Claude Code 的全屏渲染器在探测不到滚轮倍率的终端（xterm.js 系）上按 1 行/格
  算，所以「发出几格」就是「滚几行」。再叠一道 0.3，一次轻扫只剩原生的三成。
*/
test("转发给 TUI 时不打触控板阻尼，格数跟住原生行数", () => {
  const cellHeight = 20;
  // 同一串轻扫事件：打阻尼只滚 3 行，不打阻尼滚满 11 行（112 × 2px / 20px）。
  const sweep = (damp: boolean) => {
    let carry = 0, ticks = 0;
    for (let i = 0; i < 112; i++) {
      const r = wheelTicks(wheel(2), cellHeight, carry, damp);
      carry = r.carry;
      ticks += r.ticks;
    }
    return ticks;
  };
  assert.equal(sweep(true), 3, "本地滚动保持和 xterm 一致");
  assert.equal(sweep(false), 11, "转发路径按真实位移走");
  // 整格鼠标滚轮本来就不打阻尼，两边必须一样。
  assert.equal(wheelTicks(wheel(100), cellHeight, 0, true).ticks, 5);
  assert.equal(wheelTicks(wheel(100), cellHeight, 0, false).ticks, 5);
});

function fakeHost() {
  const listeners: ((ev: WheelEvent) => void)[] = [];
  const rect = { width: 1460, height: 920, left: 0, top: 0 };
  const el = {
    addEventListener: (_t: string, fn: (ev: WheelEvent) => void) => { listeners.push(fn); },
    removeEventListener: (_t: string, fn: (ev: WheelEvent) => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    getBoundingClientRect: () => rect,
  } as unknown as HTMLElement;
  let prevented = 0;
  const fire = (deltaY: number) => {
    const ev = {
      deltaY, deltaMode: PIXEL, shiftKey: false, clientX: 700, clientY: 400,
      preventDefault: () => { prevented++; }, stopPropagation: () => {},
    } as unknown as WheelEvent;
    for (const fn of [...listeners]) fn(ev);
  };
  return { el, fire, get prevented() { return prevented; }, get attached() { return listeners.length; } };
}

// 没有 rAF 的宿主退回 16ms 定时器，等够一帧再断言。
const frame = () => new Promise((r) => setTimeout(r, 40));

test("一次手势的多个滚轮事件合并成一条序列，而不是逐个往返", async () => {
  const host = fakeHost();
  const sent: string[] = [];
  const stop = attachHostWheel(
    host.el,
    () => ({ cols: 146, rows: 46, mouseTracking: true, altScreen: true }),
    (d) => sent.push(d),
  );
  // 一次轻扫：20 个像素事件，每个 40px（每行 20px）= 共 40 行。
  for (let i = 0; i < 20; i++) host.fire(40);
  assert.equal(sent.length, 0, "帧内不该先发出去");
  await frame();
  assert.equal(sent.length, 1, "整次手势只发一条");
  assert.equal(sent[0], "\x1b[<65;71;21M".repeat(40));
  assert.equal(host.prevented, 20, "每个事件都要吃掉，页面不能跟着滚");
  stop();
  assert.equal(host.attached, 0);
});

test("同一帧内反向滚动互相抵消，不会来回抖", async () => {
  const host = fakeHost();
  const sent: string[] = [];
  const stop = attachHostWheel(
    host.el,
    () => ({ cols: 146, rows: 46, mouseTracking: true, altScreen: true }),
    (d) => sent.push(d),
  );
  host.fire(200);   // 10 行向下
  host.fire(-160);  // 8 行向上
  await frame();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "\x1b[<65;71;21M".repeat(2), "净 2 行向下");
  stop();
});

test("TUI 在合并窗口内退出时丢掉这几行，不发给普通 shell", async () => {
  const host = fakeHost();
  const sent: string[] = [];
  let inTui = true;
  const stop = attachHostWheel(
    host.el,
    () => ({ cols: 146, rows: 46, mouseTracking: inTui, altScreen: inTui }),
    (d) => sent.push(d),
  );
  host.fire(200);
  inTui = false;
  await frame();
  assert.deepEqual(sent, []);
  stop();
});

test("普通 shell 下不拦截滚轮，交回 xterm 自己滚历史", async () => {
  const host = fakeHost();
  const sent: string[] = [];
  const stop = attachHostWheel(
    host.el,
    () => ({ cols: 146, rows: 46, mouseTracking: false, altScreen: false }),
    (d) => sent.push(d),
  );
  for (let i = 0; i < 10; i++) host.fire(40);
  await frame();
  assert.deepEqual(sent, []);
  assert.equal(host.prevented, 0, "不 preventDefault，xterm 才能滚自己的视口");
  stop();
});
