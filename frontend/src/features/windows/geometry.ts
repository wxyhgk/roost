/*
  浮动窗口的几何。

  **窗口系统里真正会出错的全在这一层**，而且错法有一个共同点：它们都不报错，只是让
  某个窗口再也拿不回来。所以这里全部写成纯函数，逐条测。

  - 标题栏被拖出屏幕外 → 再也抓不住那个窗口，只能清 localStorage
  - 从左边/上边缩放时把宽度缩到负数 → 窗口翻过来，或者原地消失
  - 换了显示器、转了屏、收起侧栏 → 视口变小，原来在右边的窗口整个落在外面
  - 新窗口正好盖在旧窗口上 → 看起来像「点了没反应」

  这里的坐标都是相对**窗口层**（一个铺满可用区域的容器），不是相对整个页面。
*/

export type Rect = { x: number; y: number; width: number; height: number };
export type Viewport = { width: number; height: number };

/** 标题栏高度。裁剪时至少要给它留出这么多，否则窗口抓不住。 */
export const TITLE_BAR = 32;
/** 最小尺寸。再小就没有内容可显示，只剩边框。 */
export const MIN_WIDTH = 240;
export const MIN_HEIGHT = 140;
/**
 * 窗口被拖到边缘外时，至少要留在视口里的横向像素。
 *
 * 不能是 0：那样窗口可以恰好停在边界上、只剩一条缝。也不能等于整个宽度——
 * 把窗口拖到屏幕边上只露一半是**正常用法**（腾地方看后面那个）。
 */
export const KEEP_VISIBLE = 96;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * 把窗口收回到「还抓得住」的范围内。
 *
 * **不是把窗口关进视口**，而是保证标题栏够得着：横向至少露出 `KEEP_VISIBLE`，
 * 纵向标题栏不能被顶到上边界以上（那是唯一一个真正不可逆的方向——鼠标够不到，
 * 而且没有滚动条能把它拉回来）。
 */
export function clampToViewport(rect: Rect, viewport: Viewport): Rect {
  const width = Math.max(MIN_WIDTH, Math.min(rect.width, Math.max(MIN_WIDTH, viewport.width)));
  const height = Math.max(MIN_HEIGHT, Math.min(rect.height, Math.max(MIN_HEIGHT, viewport.height)));
  return {
    width, height,
    x: clamp(rect.x, KEEP_VISIBLE - width, Math.max(0, viewport.width - KEEP_VISIBLE)),
    /*
      上边界是 0 而不是 `-height + TITLE_BAR`：标题栏一旦上去就永远够不到。
      下边界留 `viewport.height - TITLE_BAR`，窗口可以沉到底下只剩标题栏——那是有用的
      （相当于最小化到底边），而且可逆。
    */
    y: clamp(rect.y, 0, Math.max(0, viewport.height - TITLE_BAR)),
  };
}

/**
 * 新窗口开在哪儿。
 *
 * 阶梯排布：每多一个窗口就往右下挪一格，**绝不和已有窗口完全重合**——完全重合时
 * 用户看到的是「点了没反应」，而实际上新窗口就在那儿。
 *
 * 排到装不下就绕回起点重新来；绕回之后仍然可能和某个旧窗口重合，那是可接受的
 * （已经开了十几个窗口，此时任何排布都在重叠），但第一圈内保证不重合。
 */
export function cascadeRect(taken: readonly Rect[], viewport: Viewport, size?: { width: number; height: number }): Rect {
  const width = Math.min(size?.width ?? 720, Math.max(MIN_WIDTH, viewport.width - 2 * TITLE_BAR));
  const height = Math.min(size?.height ?? 480, Math.max(MIN_HEIGHT, viewport.height - 2 * TITLE_BAR));
  const step = TITLE_BAR;
  /*
    一圈能放多少格：到放不下为止。视口比窗口还小时这个数会是负的，循环直接不执行，
    落到下面那个兜底——和 i=0 是同一个结果，所以**不需要**再给它加一层
    `Math.max(1, …)`。原来有一层，变异测试把它删掉之后所有用例照样绿：那是死代码。
  */
  const slots = Math.min(
    Math.floor((viewport.width - width) / step) + 1,
    Math.floor((viewport.height - height) / step) + 1);
  for (let i = 0; i < slots; i++) {
    const candidate = clampToViewport({ x: step * i, y: step * i, width, height }, viewport);
    if (!taken.some(rect => rect.x === candidate.x && rect.y === candidate.y)) return candidate;
  }
  return clampToViewport({ x: 0, y: 0, width, height }, viewport);
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * 拖动某条边/某个角之后的新矩形。
 *
 * **从左边或上边缩放时，x/y 要跟着动，而且不能让宽高掉到最小值以下。** 天真的写法
 * （`width -= dx` 然后再夹一次）会在越过最小宽度之后让窗口继续往右跑——边被拖过了头，
 * 对面那条边却跟着移动。所以这里先算出被夹住的宽度，再由它反推 x。
 */
export function resizeRect(rect: Rect, edge: ResizeEdge, dx: number, dy: number, viewport: Viewport): Rect {
  let { x, y, width, height } = rect;
  if (edge.includes('e')) width = Math.max(MIN_WIDTH, rect.width + dx);
  if (edge.includes('w')) {
    // 右边固定：左边最多推到 `right - MIN_WIDTH`，再往右推宽度也不再变。
    const right = rect.x + rect.width;
    width = Math.max(MIN_WIDTH, rect.width - dx);
    x = right - width;
  }
  if (edge.includes('s')) height = Math.max(MIN_HEIGHT, rect.height + dy);
  if (edge.includes('n')) {
    const bottom = rect.y + rect.height;
    height = Math.max(MIN_HEIGHT, rect.height - dy);
    y = bottom - height;
  }
  return clampToViewport({ x, y, width, height }, viewport);
}

/**
 * 把某个窗口提到最前。
 *
 * 用**顺序数组**表示层叠，不给每个窗口存一个 z-index 数字：数字那套要么越加越大，
 * 要么在删窗口之后留下空洞，而「谁在最前」本来就是一个顺序问题。数组末尾是最前。
 *
 * 不在数组里的 id 原样返回，不凭空插入——调用方可能拿着一个已经关掉的窗口 id。
 */
export function raise(order: readonly string[], id: string): string[] {
  if (!order.includes(id) || order[order.length - 1] === id) return [...order];
  return [...order.filter(other => other !== id), id];
}

/** 视口变了（转屏、收侧栏、换显示器）之后，把所有窗口重新收回可达范围。 */
export function reflow<T extends { rect: Rect }>(windows: readonly T[], viewport: Viewport): T[] {
  return windows.map(window => ({ ...window, rect: clampToViewport(window.rect, viewport) }));
}

/** 最大化时铺满整个窗口层；留出边距让人看得出底下还有东西。 */
export function maximizedRect(viewport: Viewport): Rect {
  return { x: 0, y: 0, width: Math.max(MIN_WIDTH, viewport.width), height: Math.max(MIN_HEIGHT, viewport.height) };
}
