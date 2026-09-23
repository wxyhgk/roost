import { cellFromPointer, encodeTuiWheel, wheelTicks } from "./wheel";

/**
 * 手指划屏 → 和滚轮**完全同一套**的终端滚动。
 *
 * 为什么要自己做：装的 `@xterm/xterm@6.0.0` 触摸滚动为零（`handleTouchScroll` 一次
 * 都不会被调到，`addTarget` 只有类定义没有调用点），上游要到 6.1.0-beta 才修，而 npm
 * 上的 `latest` 还是 6.0.0。手机上现在是**划不动的**，不是滚得不顺。
 *
 * 为什么不新造一套语义：`wheel.ts` 已经把「滚一下终端」分成三岔——
 * mouseTracking 发鼠标事件、altScreen 发方向键、都不是就滚自己的回滚历史。
 * 这三岔是 Termux 的 `doScroll()` 和 a-Shell 的 `handleVertical_()` 各自独立收敛到的
 * 同一套，手指和滚轮没有任何理由分开。**所以这里只负责把手指位移翻译成像素位移，
 * 判定和编码一律回头调 wheel.ts**，一份实现。
 *
 * 尤其要紧的是 altScreen 那一岔：claude / codex 这些 AI CLI 全跑在 alternate screen 上，
 * 手机上划屏的正确语义是**发方向键**（它们自己画滚动），不是去滚 xterm 的回滚历史——
 * 后者在 alt screen 上根本没有内容可翻。
 *
 * 纯逻辑（定轴、吸附、余数）抽在下半段的 `beginGesture` / `moveGesture` 里，
 * 理由和 `fit.ts` 一样：这里唯一有分量的规则都是些**很容易在重写时被当成多余防御删掉**
 * 的判断（不足一格不发、斜划不换轴、小位移不算滚动），而它们只有作为纯函数才测得到。
 */

/**
 * 位移小于这个数的抬手**不算滚动，是点击**。
 *
 * 手指按下时纹丝不动是不可能的，几像素的抖动一律要还给点击。取 8px（mywebterm 的取值）。
 *
 * **上限由 TermView 定**：选择模式下那边用 10px 判定「这一下是轻点」。这个数必须 ≤ 10，
 * 否则 8~10 之间会出现一条死带——我们已经吃掉了事件，那边又认为位移太大不算轻点，
 * 两边都不响应。
 */
export const TAP_SLOP_PX = 8;

/**
 * 定轴之后要在另一个方向再走多少**格**才允许改主意。取自 a-Shell 的
 * `SNAP_BREAKAWAY_VERT_CHARS = 4` / `SNAP_BREAKAWAY_HORIZ_CHARS = 6`。
 *
 * 没有这道吸附，斜着滑的那一下会**一边发方向键一边被当成横划**，手感是「滚一下跳一下」。
 * 横向的阈值更大，是因为竖划才是终端的常态动作，从竖切到横应当更难。
 */
export const SNAP_BREAKAWAY_VERT_CELLS = 4;
export const SNAP_BREAKAWAY_HORIZ_CELLS = 6;

export type Axis = "undecided" | "vertical" | "horizontal";

export type Gesture = {
  axis: Axis;
  /** 手指按下的位置。判定「点击还是滑动」的基准，全程不变。 */
  startX: number;
  startY: number;
  /** 定轴那一刻的位置。换轴要从这里重新走够 breakaway，而不是从按下算起。 */
  snapX: number;
  snapY: number;
  /** 上一次采样的纵坐标：每一小段位移都要单独进余数。 */
  lastY: number;
  /** 不足一格的零头，跨事件留着。语义和 wheel.ts 的 carry 完全一致。 */
  carry: number;
};

export type Step = {
  gesture: Gesture;
  /** 这一步攒够的整格数，带符号；正数 = 内容向下（和滚轮 deltaY > 0 同义）。 */
  ticks: number;
  /** 这一下归不归我们。归我们才 preventDefault，否则点击和横划都会被吃掉。 */
  consume: boolean;
};

export function beginGesture(x: number, y: number): Gesture {
  // carry 每次手势从零开始：抬手就是一次动作结束，上一次剩的半格不该带到下一次去
  // （这一点和 wheel.ts 的按宿主保管不同——滚轮没有「抬手」这个边界）。
  return { axis: "undecided", startX: x, startY: y, snapX: x, snapY: y, lastY: y, carry: 0 };
}

export function moveGesture(
  g: Gesture,
  x: number,
  y: number,
  cell: { width: number; height: number },
): Step {
  // 量不出格子（元素还没布局完）时退回近似值，理由同 wheel.ts：总比不滚强。
  const cellHeight = cell.height > 0 ? cell.height : 40;
  const cellWidth = cell.width > 0 ? cell.width : 8;

  let { axis, snapX, snapY, lastY, carry } = g;

  if (axis === "undecided") {
    const dx = x - g.startX;
    const dy = y - g.startY;
    // 还没走够阈值：什么都不做，也**不吃掉事件**——这一下还可能是点击。
    if (Math.hypot(dx, dy) < TAP_SLOP_PX) return { gesture: g, ticks: 0, consume: false };
    axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
    snapX = x;
    snapY = y;
    // 从**按下的位置**重新起算，不是从判定点。否则每次手势开头那 8 像素凭空消失，
    // 滑一小段永远差一格。
    lastY = g.startY;
    carry = 0;
  } else {
    const awayX = Math.abs(x - snapX);
    const awayY = Math.abs(y - snapY);
    const broke =
      axis === "vertical"
        ? awayX > SNAP_BREAKAWAY_HORIZ_CELLS * cellWidth && awayX > awayY
        : awayY > SNAP_BREAKAWAY_VERT_CELLS * cellHeight && awayY > awayX;
    if (broke) {
      axis = axis === "vertical" ? "horizontal" : "vertical";
      snapX = x;
      snapY = y;
      // 换轴等于重新起手：上一段轴上的零头和位移都不算数。
      lastY = y;
      carry = 0;
    }
  }

  // 横向归浏览器（抽屉、返回手势）。不发、不吃。
  if (axis !== "vertical") return { gesture: { ...g, axis, snapX, snapY, lastY: y, carry }, ticks: 0, consume: false };

  /*
    手指向下 = 内容跟着往下走 = 往回翻历史 = 滚轮的 deltaY < 0。所以取负号。

    `damp = false`：那 0.3 阻尼是 xterm 给自己本地滚动用的平滑，而手指是**直接位移**，
    打了阻尼就是「滑 100 像素内容走 30」，和手指脱钩。理由和 wheel.ts 转发给 TUI 那条
    一样，只是成因不同：那边是怕滚得太少，这边是手指必须跟手。
  */
  const scrolled = wheelTicks(asWheelDelta(-(y - lastY)), cellHeight, carry, false);
  return {
    gesture: { ...g, axis, snapX, snapY, lastY: y, carry: scrolled.carry },
    ticks: scrolled.ticks,
    consume: true,
  };
}

/*
  `wheelTicks` 和 `cellFromPointer` 只读 deltaY/deltaMode 和 clientX/clientY 这四个字段。
  手指位移和滚轮的像素位移本来就是同一种量，所以这里**复用它们而不是抄一遍**：
  「不足一格不发、余数跨事件留着」那套只该有一份实现，抄出第二份必然漂。

  代价是要造一个只有那几个字段的假事件。真正该做的是把 wheel.ts 那两个函数改成按数字
  取参（deltaY/deltaMode、x/y），但那要动既有文件，留给下一次。
*/
const asWheelDelta = (deltaY: number) =>
  // deltaMode 0 = DOM_DELTA_PIXEL：手指位移就是 CSS 像素。
  ({ deltaY, deltaMode: 0 }) as unknown as WheelEvent;
const asWheelPoint = (clientX: number, clientY: number) =>
  ({ clientX, clientY }) as unknown as WheelEvent;

// 宿主没有 rAF（测试、SSR）时退回定时器，同 wheel.ts。
const nextFrame: (cb: () => void) => () => void =
  typeof requestAnimationFrame === "function"
    ? (cb) => { const id = requestAnimationFrame(() => cb()); return () => cancelAnimationFrame(id); }
    : (cb) => { const id = setTimeout(cb, 16); return () => clearTimeout(id); };

export function attachHostTouchScroll(
  host: HTMLElement,
  state: () => {
    cols: number;
    rows: number;
    mouseTracking: boolean;
    altScreen: boolean;
    target?: HTMLElement;
  },
  send: (data: string) => void,
  /** 三岔的第三条：既不是 mouseTracking 也不是 alt screen 时，滚 xterm 自己的回滚历史。
   *  滚轮那条路上这一步是交回 xterm 做的，而 6.0.0 的触摸滚动为零，所以必须自己调。 */
  scrollLines?: (amount: number) => void,
) {
  let gesture: Gesture | null = null;
  let pending = 0;
  let at: { col: number; row: number } | null = null;
  let cancelFrame: (() => void) | null = null;

  function flush() {
    cancelFrame = null;
    const ticks = pending;
    const cell = at;
    pending = 0;
    at = null;
    if (!ticks || !cell) return;
    const now = state();
    // 攒的这一帧里 TUI 可能已经退出了，所以判定要用**现在**的状态，不是当时的。
    const payload = encodeTuiWheel({
      mouseTracking: now.mouseTracking,
      altScreen: now.altScreen,
      ...cell,
      deltaY: ticks,
      ticks,
    });
    if (payload) { send(payload); return; }
    scrollLines?.(ticks);
  }

  const onStart = (ev: TouchEvent) => {
    // 多指一律放弃：双指留给缩放，长按两点留给选区。判错方向比不响应难受得多。
    gesture = ev.touches.length === 1 ? beginGesture(ev.touches[0].clientX, ev.touches[0].clientY) : null;
  };

  const onMove = (ev: TouchEvent) => {
    if (!gesture) return;
    // 手势中途多了一根手指：这已经不是滚动了，剩下的一路都不要。
    if (ev.touches.length !== 1) { gesture = null; return; }
    const touch = ev.touches[0];
    const now = state();
    const target = now.target ?? host;
    const rect = target.getBoundingClientRect();
    const step = moveGesture(gesture, touch.clientX, touch.clientY, {
      width: now.cols > 0 ? rect.width / now.cols : 0,
      height: now.rows > 0 ? rect.height / now.rows : 0,
    });
    gesture = step.gesture;
    if (!step.consume) return;
    // 攒没攒够一格都要吃掉：否则页面跟着滚、终端反而不动（同 wheel.ts）。
    ev.preventDefault();
    if (!step.ticks) return;
    pending += step.ticks;
    at = cellFromPointer(target, now.cols, now.rows, asWheelPoint(touch.clientX, touch.clientY));
    // 一次划屏几十个 touchmove，逐个发就是逐个网络往返；按帧合并成一条。
    cancelFrame ??= nextFrame(flush);
  };

  const onEnd = () => { gesture = null; };

  /*
    **必须让出垂直方向的原生手势**，否则浏览器一旦开始接管这次平移，之后的
    preventDefault 就失效了（passive cancel）——CSS 里 `.term-fit .xterm-viewport`
    是 `overflow-y: auto`，正是会被接管的形状。

    只让出垂直：`pan-x` 留给窄屏抽屉那类横划，`pinch-zoom` 留着不动——双指缩放在手机上
    是读小字唯一的办法，为了滚动把它关掉是亏的。
  */
  const restoreTouchAction = host.style.touchAction;
  host.style.touchAction = "pan-x pinch-zoom";

  host.addEventListener("touchstart", onStart, { passive: true, capture: true });
  host.addEventListener("touchmove", onMove, { passive: false, capture: true });
  host.addEventListener("touchend", onEnd, { passive: true, capture: true });
  host.addEventListener("touchcancel", onEnd, { passive: true, capture: true });

  return () => {
    host.removeEventListener("touchstart", onStart, { capture: true });
    host.removeEventListener("touchmove", onMove, { capture: true });
    host.removeEventListener("touchend", onEnd, { capture: true });
    host.removeEventListener("touchcancel", onEnd, { capture: true });
    host.style.touchAction = restoreTouchAction;
    cancelFrame?.();
    cancelFrame = null;
    gesture = null;
    pending = 0;
    at = null;
  };
}
