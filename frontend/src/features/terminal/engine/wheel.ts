// deltaMode 的取值由 DOM 规范固定，直接写常量而不去全局 WheelEvent 上取：
// 这个模块是纯计算，不该因为宿主没有 DOM 全局就崩掉。
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * 滚轮事件 → 行数。返回带符号的行数与**要传回下一次调用的余数**。
 *
 * 余数必须跨事件累积，否则触控板没法用：一次轻扫会发出十几个 deltaY≈2 的
 * 像素事件，每个单独看都不足一行，但只要各自向上取整就变成滚了十几行。
 * 所以这里返回 0 是正常且必要的——「还不够一行」。
 *
 * 算法取自 xterm 自己的 Viewport._getLinesScrolled：按每格高度换算成行、余数保留到下一次。
 *
 * **不打 xterm 那道 0.3 触控板阻尼。** 原来这里有个 `damp` 参数默认 true，理由写的是
 * 「和 xterm 的本地滚动保持一致」——但本地滚动那条路根本不经过这个函数：attachHostWheel
 * 判定不转发时直接 return，滚动、阻尼、余数全在 xterm 自己肚子里。于是两个调用点（转发给
 * TUI、手指划屏）都显式传 false，默认值只有测试走得到，注释却在解释一个不存在的路径。
 * 删掉参数，两条真实路径为什么不要阻尼见 attachHostWheel 和 touchScroll 里的说明。
 *
 * 保持纯函数：余数显式传入传出，调用方自己保管，测试才能一次跑完整串事件。
 */
export function wheelTicks(
  ev: WheelEvent,
  cellHeight: number,
  carry = 0,
): { ticks: number; carry: number } {
  if (ev.deltaY === 0) return { ticks: 0, carry };
  if (ev.deltaMode === DOM_DELTA_LINE) return { ticks: Math.trunc(ev.deltaY), carry };
  // 一页按一屏算；这里拿不到行数，沿用原先的近似值。
  if (ev.deltaMode === DOM_DELTA_PAGE) return { ticks: Math.trunc(ev.deltaY) * 8, carry };
  // 每格高度拿不到时（元素还没量出来）退回原先的 40px 近似，总比不滚强。
  const amount = ev.deltaY / (cellHeight > 0 ? cellHeight : 40);
  const total = carry + amount;
  // `|| 0` 是为了掐掉负零：反向滚动正好抵消时会算出 -0，它和 0 行为一样但比较不相等。
  return { ticks: Math.trunc(total) || 0, carry: total % 1 };
}

export function cellFromPointer(
  el: HTMLElement,
  cols: number,
  rows: number,
  ev: WheelEvent,
) {
  const rect = el.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const col = Math.max(
    1,
    Math.min(cols, Math.floor((x / Math.max(rect.width, 1)) * cols) + 1),
  );
  const row = Math.max(
    1,
    Math.min(rows, Math.floor((y / Math.max(rect.height, 1)) * rows) + 1),
  );
  return { col, row };
}

export function encodeTuiWheel(opts: {
  mouseTracking: boolean;
  altScreen: boolean;
  col: number;
  row: number;
  deltaY: number;
  ticks: number;
}): string | null {
  // 0 是「还不够一行」，不是「至少滚一行」——把它当 1 正是触控板过灵敏的成因。
  const n = Math.trunc(Math.abs(opts.ticks));
  if (n < 1) return null;
  if (opts.mouseTracking) {
    const button = opts.deltaY < 0 ? 64 : 65;
    return `\x1b[<${button};${opts.col};${opts.row}M`.repeat(n);
  }
  if (opts.altScreen) {
    return (opts.deltaY < 0 ? "\x1b[A" : "\x1b[B").repeat(n);
  }
  return null;
}

// 宿主没有 rAF（测试、SSR）时退回定时器：合并窗口本身不该是硬依赖。
const nextFrame: (cb: () => void) => () => void =
  typeof requestAnimationFrame === "function"
    ? (cb) => { const id = requestAnimationFrame(() => cb()); return () => cancelAnimationFrame(id); }
    : (cb) => { const id = setTimeout(cb, 16); return () => clearTimeout(id); };

export function attachHostWheel(
  host: HTMLElement,
  state: () => {
    cols: number;
    rows: number;
    mouseTracking: boolean;
    altScreen: boolean;
    target?: HTMLElement;
  },
  send: (data: string) => void,
) {
  // 余数按宿主保管：一个终端的半行不该带到另一个终端上去。
  let carry = 0;
  // 一帧之内攒下的行数与最后一次指针位置；带符号，中途反向会自己抵消。
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
    // 攒的这一帧里 TUI 可能已经退出了；这时这些行不属于任何人，丢掉。
    const payload = encodeTuiWheel({
      mouseTracking: now.mouseTracking,
      altScreen: now.altScreen,
      ...cell,
      deltaY: ticks,
      ticks,
    });
    if (payload) send(payload);
  }

  const onWheel = (ev: WheelEvent) => {
    if (ev.shiftKey) return;
    const now = state();
    const forwarding = now.mouseTracking || now.altScreen;
    if (!forwarding) {
      // 交回 xterm 自己处理（普通 shell 的滚动历史）。它有自己的半行余数，
      // 我们这边清零，下次进 TUI 时不要带着上一段的零头开始。
      carry = 0;
      return;
    }
    const target = now.target ?? host;
    const rect = target.getBoundingClientRect();
    const cellHeight = now.rows > 0 ? rect.height / now.rows : 0;
    /*
      转发给 TUI 的行数按真实位移算，不打 xterm 那道 0.3 阻尼。

      那 0.3 是 xterm 给**自己的本地滚动**用的：它一帧能重画好几次，滚慢一点是顺滑。
      而 TUI 自绘滚动是「一格 → 一次网络往返 → 重画一屏」的离散动作，Claude Code
      的全屏渲染器在探测不到倍率的终端上按 1 行/格算（实测确认），再叠上 0.3 就只剩
      原生的三成——滑一下爬两行。本地滚动那条路不经过这里（上面就 return 了），所以
      wheelTicks 里索性没有阻尼这回事。
    */
    const scrolled = wheelTicks(ev, cellHeight, carry);
    carry = scrolled.carry;
    // 不管这次攒没攒够一行都要吃掉事件：否则页面会跟着滚，终端反而不动。
    ev.preventDefault();
    ev.stopPropagation();
    if (!scrolled.ticks) return;
    pending += scrolled.ticks;
    at = cellFromPointer(target, now.cols, now.rows, ev);
    // 一次触控板轻扫会发十几到二十几个事件。逐个发就是逐个往返，
    // 远程链路上这就是「卡」的来源；按帧合并成一条，手感和数据量都回来了。
    cancelFrame ??= nextFrame(flush);
  };

  host.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => {
    host.removeEventListener("wheel", onWheel, { capture: true });
    cancelFrame?.();
    cancelFrame = null;
    pending = 0;
    at = null;
  };
}
