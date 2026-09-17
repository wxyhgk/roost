import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * 一个可以拖动、可以缩放、双击复位的浮动面板。
 *
 * 这一摊从 `FilePreviewModal` 里搬出来：它 525 行里有整整一簇和「文件」毫无关系
 * 的东西——指针手势、边界收敛、窗口缩放时的重新钳制。搬走之后那个组件只剩「读一个
 * 文件、改它、存回去」。
 *
 * **没有放进 shared/ui**：全项目只有这一个可拖拽面板（`setPointerCapture` 全局仅此
 * 一处）。现在搬过去是在替一个还不存在的第二个使用者做决定。等真有第二个，挪一个
 * 自足的文件是一次 git mv。
 */

const clampNum = (v: number, lo: number, hi: number) =>
  hi < lo ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi);

type Gesture = {
  kind: "move" | "resize";
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  moved: boolean;
  /**
   * 手势进行中的实时值。**不进 React state**：每帧 setState 会重渲染整个面板子树，
   * 而那里可能挂着 CodeMirror 或 markdown/shiki 的渲染结果，60Hz 重渲染是卡顿的主因。
   * 拖动期间直接写 DOM 样式，松手时才提交一次。
   * 渲染读它是为了防止手势期间的外部重渲染（比如文件监听触发的刷新）
   * 用陈旧的 state 把面板弹回原位。
   */
  livePos?: { x: number; y: number };
  liveSize?: { w: number; h: number };
};

export function useDraggablePanel({ minWidth, minHeight, keepVisible = 120, fallbackSize, initialOffset }: {
  minWidth: number;
  minHeight: number;
  /** 拖出屏幕时至少保留这么多像素可见，避免面板「丢失」。 */
  keepVisible?: number;
  /**
   * 开局就相对居中位置挪开这么多。给「同时开好几个面板」用：全都精确居中的话，
   * 后开的会把先开的完全盖住，看上去就像前一个没了。
   *
   * 双击复位回到的是这个偏移，不是死正中——复位的意思是「回到它该在的地方」。
   */
  initialOffset?: { x: number; y: number };
  /**
   * 还没量到真实尺寸时按这个算。
   *
   * 必须由调用方给：面板的默认大小写在它自己的 className 里（`w-[min(760px,92vw)]`
   * 之类），这个 hook 看不见。给错了只影响第一次拖动的边界，但会表现为「刚打开时
   * 拖一下位置不对」这种极难复现的毛病。
   */
  fallbackSize: { w: number; h: number };
}) {
  // null 表示没动过：走面板自己 CSS 的默认居中 / 默认尺寸。
  const [pos, setPos] = useState<{ x: number; y: number } | null>(initialOffset ?? null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 复位的目标。每次渲染都会拿到一个新的对象字面量，所以存最新的值而不是闭包捕获。
  const home = useRef(initialOffset);
  home.current = initialOffset;
  const gestureRef = useRef<Gesture | null>(null);
  // 拖动/缩放到外面松开会产生一次 click；记录截止时间避免误当点击，
  // 用时间戳而不用布尔值，防止残留导致下一次正常点击被吞。
  const suppressClickUntil = useRef(0);
  // 手势进行中。只在开始和结束各切一次，不是每帧。

  // 面板默认用 flex 居中，pos 是相对居中位置的偏移。
  function clampPos(x: number, y: number, w: number, h: number) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      x: clampNum(x, keepVisible - (vw / 2 + w / 2), vw / 2 + w / 2 - keepVisible),
      y: clampNum(y, keepVisible - (vh / 2 + h / 2), vh / 2 + h / 2 - keepVisible),
    };
  }

  function clampSize(w: number, h: number) {
    return {
      w: Math.max(minWidth, Math.min(w, Math.max(window.innerWidth - 32, minWidth))),
      h: Math.max(minHeight, Math.min(h, Math.max(window.innerHeight - 32, minHeight))),
    };
  }

  function measurePanel() {
    const rect = panelRef.current?.getBoundingClientRect();
    return { w: rect?.width ?? fallbackSize.w, h: rect?.height ?? fallbackSize.h };
  }

  function begin(e: ReactPointerEvent, kind: Gesture["kind"]) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const { w, h } = measurePanel();
    gestureRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos?.x ?? 0,
      origY: pos?.y ?? 0,
      origW: size?.w ?? w,
      origH: size?.h ?? h,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function move(e: ReactPointerEvent) {
    const g = gestureRef.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
    const panel = panelRef.current;
    if (g.kind === "move") {
      // 尺寸在手势开始时量过一次就够了：移动不改变它。每帧再量一次
      // getBoundingClientRect 会强制同步布局，白白多一次代价。
      const next = clampPos(g.origX + dx, g.origY + dy, g.origW, g.origH);
      g.livePos = next;
      if (panel) panel.style.transform = `translate(${next.x}px, ${next.y}px)`;
    } else {
      const next = clampSize(g.origW + dx, g.origH + dy);
      g.liveSize = next;
      if (panel) { panel.style.width = `${next.w}px`; panel.style.height = `${next.h}px`; }
    }
  }

  function end() {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    if (g.moved) suppressClickUntil.current = Date.now() + 350;
    // 松手时才提交：整场拖动只有开始和结束各一次重渲染，而不是每帧一次。
    if (g.livePos) setPos(g.livePos);
    if (g.liveSize) setSize(g.liveSize);
  }

  function reset() {
    setPos(home.current ?? null);
    setSize(null);
  }

  // 窗口缩放时把已拖动的面板收敛回可视范围。
  useEffect(() => {
    const onWinResize = () => {
      const { w, h } = measurePanel();
      setSize((s) => (s ? clampSize(s.w, s.h) : s));
      setPos((p) => (p ? clampPos(p.x, p.y, w, h) : p));
    };
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
    // 空依赖是对的：里面用的全是 ref 和 setState 的函数式更新，没有会过期的闭包值。
  }, []);

  // 手势进行中以 ref 里的实时值为准：这样即便有外部原因触发重渲染，
  // 也不会用尚未提交的 state 把正在拖动的面板弹回原位。
  const livePos = gestureRef.current?.livePos ?? pos;
  const liveSize = gestureRef.current?.liveSize ?? size;

  const gestureHandlers = {
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onDoubleClick: reset,
  };

  return {
    /** 挂到面板本体上。手势期间直接写它的 style，绕开 React。 */
    ref: panelRef,
    /** 拖动或缩放进行中。调用方用它在手势期间关掉昂贵的视觉效果。 */
    /** 摊到面板的 style 上。没动过时是空对象，让 CSS 里的默认值生效。 */
    style: {
      ...(livePos ? { transform: `translate(${livePos.x}px, ${livePos.y}px)` } : null),
      ...(liveSize
        ? { width: liveSize.w, height: liveSize.h, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", minHeight: 0 }
        : null),
    },
    /** 摊到标题栏上：按住拖动，双击复位。 */
    moveHandlers: {
      ...gestureHandlers,
      onPointerDown(e: ReactPointerEvent) {
        // 标题栏上的按钮（编辑、关闭之类）不该触发拖动。
        if ((e.target as HTMLElement).closest("button")) return;
        begin(e, "move");
      },
    },
    /** 摊到右下角把手上：按住缩放，双击复位。 */
    resizeHandlers: {
      ...gestureHandlers,
      onPointerDown: (e: ReactPointerEvent) => begin(e, "resize"),
    },
    /**
     * 这次 click 是拖动松手带出来的，不该当成点击处理。
     *
     * 手势在遮罩上松开会冒出一次 click，而遮罩的 click 是「关闭」。不挡住的话，
     * 把面板拖到边上松手就会顺手把它关了。
     */
    isGestureClick: () => Date.now() < suppressClickUntil.current,
  };
}
