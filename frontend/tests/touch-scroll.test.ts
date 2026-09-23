import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachHostTouchScroll,
  beginGesture,
  moveGesture,
  type Gesture,
} from "../src/features/terminal/engine/touchScroll";

// 一个 80x24 的终端，内容区 800x480，于是每格 10x20。和 touch-select 那份用同一套数。
const CELL = { width: 10, height: 20 };

/** 顺着走一串触点，返回每一步的 (ticks, consume, axis)。 */
function swipe(from: { x: number; y: number }, points: { x: number; y: number }[]) {
  let g: Gesture = beginGesture(from.x, from.y);
  return points.map((p) => {
    const step = moveGesture(g, p.x, p.y, CELL);
    g = step.gesture;
    return { ticks: step.ticks, consume: step.consume, axis: g.axis };
  });
}

test("不足一格不发，零头跨事件累积到够一格才发", () => {
  // 每次只走 6 像素，一格是 20：单看每一步都不够，但走到第 24 像素就该整整一格。
  const steps = swipe({ x: 100, y: 300 }, [
    { x: 100, y: 294 },
    { x: 100, y: 288 },
    { x: 100, y: 282 },
    { x: 100, y: 276 },
  ]);
  assert.deepEqual(steps.map((s) => s.ticks), [0, 0, 0, 1], "零头不清零，第 24 像素上补出一格");
  // 手指向上抬 = 看后面的内容 = 滚轮的 deltaY > 0，所以是正数。
  assert.ok(steps[3].ticks > 0);
});

test("位移小于点击阈值的那一段既不滚也不吃事件", () => {
  const steps = swipe({ x: 100, y: 300 }, [
    { x: 102, y: 297 },
    { x: 103, y: 295 },
  ]);
  assert.deepEqual(steps.map((s) => s.consume), [false, false], "这是点击，吃掉它就再也点不着终端");
  assert.deepEqual(steps.map((s) => s.axis), ["undecided", "undecided"]);
});

test("定轴那一刻从按下的位置起算，开头那几像素不能凭空消失", () => {
  // 一次干净的 20 像素竖划正好一格。若从判定点（第 9 像素处）起算就只剩 11 像素 → 0 格。
  const steps = swipe({ x: 100, y: 300 }, [{ x: 100, y: 291 }, { x: 100, y: 280 }]);
  assert.equal(steps[0].ticks, 0, "9 像素还不够一格");
  assert.equal(steps[1].ticks, 1, "累计 20 像素 = 一格");
});

test("竖直定轴后，横向漂移不到 6 格不换轴，继续滚", () => {
  const steps = swipe({ x: 100, y: 300 }, [
    { x: 100, y: 250 },  // 竖直定轴：50 像素 = 2.5 格
    { x: 150, y: 245 },  // 横漂 50 < 6 格(60)：还是竖的
    { x: 175, y: 240 },  // 横漂 75 > 60 且压过竖向：这才换轴
  ]);
  assert.deepEqual(steps.map((s) => s.axis), ["vertical", "vertical", "horizontal"]);
  assert.equal(steps[1].consume, true, "斜一点的竖划还是竖划");
  assert.equal(steps[2].consume, false, "认成横划之后就交回浏览器，不能又发方向键又横划");
  assert.equal(steps[2].ticks, 0);
});

test("横向定轴后，竖向漂移不到 4 格不换轴，一格都不滚", () => {
  const steps = swipe({ x: 100, y: 300 }, [
    { x: 160, y: 300 },  // 横向定轴
    { x: 165, y: 350 },  // 竖漂 50 < 4 格(80)：仍是横划，一格都不该滚
    { x: 170, y: 390 },  // 竖漂 90 > 80 且压过横向：换回竖直
    { x: 170, y: 370 },  // 换轴后重新起算，这 20 像素 = 一格
  ]);
  assert.deepEqual(steps.map((s) => s.axis), ["horizontal", "horizontal", "vertical", "vertical"]);
  assert.deepEqual(steps.map((s) => s.ticks), [0, 0, 0, 1]);
  assert.equal(steps[1].consume, false, "横划期间的竖向抖动不该滚屏");
});

// ---- 接到宿主上之后的整条路 ----

function fakeHost() {
  const listeners = new Map<string, ((ev: TouchEvent) => void)[]>();
  const rect = { width: 800, height: 480, left: 0, top: 0 };
  let prevented = 0;
  const el = {
    style: { touchAction: "" },
    addEventListener: (type: string, fn: (ev: TouchEvent) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: (ev: TouchEvent) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== fn));
    },
    getBoundingClientRect: () => rect,
  } as unknown as HTMLElement;
  const fire = (type: string, points: { x: number; y: number }[]) => {
    const ev = {
      touches: points.map((p) => ({ clientX: p.x, clientY: p.y })),
      preventDefault: () => { prevented++; },
    } as unknown as TouchEvent;
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
  };
  return {
    el,
    start: (x: number, y: number) => fire("touchstart", [{ x, y }]),
    move: (x: number, y: number) => fire("touchmove", [{ x, y }]),
    end: () => fire("touchend", []),
    fire,
    get prevented() { return prevented; },
    get attached() { return [...listeners.values()].flat().length; },
  };
}

// 没有 rAF 的宿主退回 16ms 定时器，等够一帧再断言。
const frame = () => new Promise((r) => setTimeout(r, 40));

function rig(mode: { mouseTracking: boolean; altScreen: boolean }) {
  const host = fakeHost();
  const sent: string[] = [];
  const scrolled: number[] = [];
  const stop = attachHostTouchScroll(
    host.el,
    () => ({ cols: 80, rows: 24, ...mode }),
    (d) => sent.push(d),
    (n) => scrolled.push(n),
  );
  return { host, sent, scrolled, stop };
}

test("alt screen 上划屏发方向键，一次手势合并成一条", async () => {
  const { host, sent, scrolled, stop } = rig({ mouseTracking: false, altScreen: true });
  host.start(400, 400);
  for (let i = 1; i <= 5; i++) host.move(400, 400 - i * 20);  // 抬手指 100 像素 = 5 格
  assert.deepEqual(sent, [], "帧内不该先发出去");
  await frame();
  // 手指往上 = 往下看 = Down。claude / codex 全在 alt screen 上，这条就是手机上的滚动。
  assert.deepEqual(sent, ["\x1b[B".repeat(5)]);
  assert.deepEqual(scrolled, [], "alt screen 上没有回滚历史可滚");
  assert.ok(host.prevented >= 5, "每个 touchmove 都要吃掉，否则页面跟着滚、终端不动");
  stop();
  assert.equal(host.attached, 0);
});

test("手指往下划发上方向键，方向不能反", async () => {
  const { host, sent, stop } = rig({ mouseTracking: false, altScreen: true });
  host.start(400, 200);
  host.move(400, 260);  // 往下 60 像素 = 3 格
  await frame();
  assert.deepEqual(sent, ["\x1b[A".repeat(3)]);
  stop();
});

test("mouseTracking 的程序收到的是鼠标滚轮事件，位置是手指所在的格子", async () => {
  const { host, sent, stop } = rig({ mouseTracking: true, altScreen: true });
  host.start(400, 400);
  host.move(400, 300);  // 100 像素 = 5 格
  await frame();
  // (400,300) → 第 41 列、第 16 行；65 = 向下滚。
  assert.deepEqual(sent, ["\x1b[<65;41;16M".repeat(5)]);
  stop();
});

test("普通 shell 下滚自己的回滚历史，不往进程里塞任何字节", async () => {
  const { host, sent, scrolled, stop } = rig({ mouseTracking: false, altScreen: false });
  host.start(400, 400);
  host.move(400, 300);
  await frame();
  assert.deepEqual(sent, [], "方向键发给 shell 就是在改命令行，不是滚屏");
  assert.deepEqual(scrolled, [5]);
  stop();
});

test("轻点不被吃掉，也不滚", async () => {
  const { host, sent, scrolled, stop } = rig({ mouseTracking: false, altScreen: true });
  host.start(400, 400);
  host.move(403, 398);
  host.move(404, 397);
  host.end();
  await frame();
  assert.deepEqual(sent, []);
  assert.deepEqual(scrolled, []);
  assert.equal(host.prevented, 0, "吃掉这一下，终端就再也点不着、软键盘也调不出来");
  stop();
});

test("多指放弃整条手势：留给缩放和选区", async () => {
  const { host, sent, stop } = rig({ mouseTracking: false, altScreen: true });
  // 两根手指按下去：从头就不是滚动。
  host.fire("touchstart", [{ x: 400, y: 400 }, { x: 200, y: 400 }]);
  host.fire("touchmove", [{ x: 400, y: 300 }, { x: 200, y: 300 }]);
  await frame();
  assert.deepEqual(sent, []);
  assert.equal(host.prevented, 0);

  // 单指划到一半又落下第二根：剩下的一路也不要了，否则缩放会变成滚屏。
  host.start(400, 400);
  host.move(400, 340);
  host.fire("touchmove", [{ x: 400, y: 300 }, { x: 200, y: 300 }]);
  host.move(400, 200);
  await frame();
  assert.deepEqual(sent, ["\x1b[B".repeat(3)], "只有第二根手指落下之前的那 60 像素算数");
  stop();
});

test("抬手之后的 touchmove 不再滚：手势有明确的终点", async () => {
  const { host, sent, stop } = rig({ mouseTracking: false, altScreen: true });
  host.start(400, 400);
  host.move(400, 340);
  host.end();
  host.move(400, 200);  // 没有 touchstart 的 move：滚动条拖拽、别的组件的手势
  await frame();
  assert.deepEqual(sent, ["\x1b[B".repeat(3)]);
  stop();
});

test("挂上去时让出垂直方向的原生手势，摘掉时还回去", () => {
  const { host, stop } = rig({ mouseTracking: false, altScreen: true });
  // 不让出来的话，浏览器一旦开始接管这次平移，后面的 preventDefault 就失效了。
  // 横划留给抽屉、双指留给缩放，所以只让垂直那一个方向。
  assert.equal(host.el.style.touchAction, "pan-x pinch-zoom");
  stop();
  assert.equal(host.el.style.touchAction, "");
});
