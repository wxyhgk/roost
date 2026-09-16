import type { Cell } from "../types";
/**
 * 触点到终端单元格的换算，以及两点成范围的规整。
 *
 * 为什么必须自己算：xterm 在 `.xterm` 上设了 `user-select: none`、自己管选区模型
 * （和用哪个渲染器无关），**浏览器里根本没有
 * 可选中的 DOM 文本**——`window.getSelection()` 在这里拿不到任何终端内容，
 * 手指长按也不会产生原生选区。所以选区只能建立在 xterm 自己的网格模型上。
 *
 * 这两个函数是纯的：坐标换算的边界（点在内容区外、反向选择、跨行长度）
 * 全在这里，留在组件里就测不到。
 */

/** 单元格坐标。row 是**绝对缓冲区行号**，不是屏幕行——否则选区会随滚动漂移。 */

export type Viewport = {
  cols: number;
  rows: number;
  /** 当前视口顶端对应的缓冲区行号（xterm 的 buffer.active.viewportY）。 */
  viewportY: number;
};

export type Rect = { left: number; top: number; width: number; height: number };

const clamp = (value: number, low: number, high: number) =>
  high < low ? low : Math.min(Math.max(value, low), high);

/**
 * 触点 → 单元格。
 *
 * 越界一律**收敛到最近的单元格**而不是返回 null：手指点在行尾右侧的空白处，
 * 意图显然是「选到这一行末尾」，判定为无效反而不合直觉。真正无效的只有
 * 「量不出内容区尺寸」这一种（元素还没布局出来）。
 */
export function pointToCell(x: number, y: number, rect: Rect, view: Viewport): Cell | null {
  if (!(rect.width > 0) || !(rect.height > 0) || view.cols < 1 || view.rows < 1) return null;
  const cellWidth = rect.width / view.cols;
  const cellHeight = rect.height / view.rows;
  const col = clamp(Math.floor((x - rect.left) / cellWidth), 0, view.cols - 1);
  const screenRow = clamp(Math.floor((y - rect.top) / cellHeight), 0, view.rows - 1);
  return { col, row: view.viewportY + screenRow };
}

/**
 * 两点 → xterm 的 select(column, row, length) 参数。
 *
 * 处理两件事：**反向选择**（终点在起点之前时对调），以及跨行长度——
 * xterm 把缓冲区看成每行 cols 个单元格的连续流，所以长度是行差乘列数再补列差。
 * 两端所在的单元格都算在内，因此 +1：点同一个格子应当选中那一个字符，而不是零个。
 *
 * 宽字符（中日韩、emoji）不需要在这里特殊处理：它们占两个单元格，
 * 按单元格计数本来就是对的，xterm 取文本时会把整个字形带上。
 */
export function selectionArgs(a: Cell, b: Cell, cols: number) {
  const [start, end] = a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
  const length = (end.row - start.row) * cols + (end.col - start.col) + 1;
  return { col: start.col, row: start.row, length: Math.max(length, 1) };
}
