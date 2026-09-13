/**
 * 容器尺寸 → 终端行列。
 *
 * **抽成纯函数是为了能测。** 这里唯一有分量的规则是「量不出一个像样的网格就别动」，
 * 而那条规则很容易在重写时被当成多余的防御删掉——代价见下面注释里的数字。
 */

/**
 * 低于这个尺寸就认为容器还没准备好，而不是「终端很小」。
 *
 * 取值只要**远离会引发灾难性重排的区间、又窄于任何真实面板**即可：手机竖屏下中间栏
 * 也有 300 像素上下，约 36 列，离 20 很远。
 */
export const MIN_FIT_COLS = 20;
export const MIN_FIT_ROWS = 4;

export type Grid = { cols: number; rows: number };

export function fitSize(
  box: { width: number; height: number },
  cell: { width: number; height: number },
  gutter: number,
  current: Grid,
): Grid {
  if (!(cell.width > 0) || !(cell.height > 0)) return current;
  const cols = Math.floor((box.width - gutter - 1) / cell.width);
  const rows = Math.floor((box.height - 1) / cell.height);
  /*
    量出来不足一个最小可用网格，说明**这次测量不可信**——容器被藏起来了、还没布局完、
    或者正卡在动画中途。这时候一步都不能走。

    原来这里是 `clientWidth <= 4` 一道门加 `Math.max(2, …)` 兜底，两者合起来是个陷阱：
    gutter 就有 14 像素，所以宽度落在 5 到约 30 之间会穿过门、算出负数、被兜成 2 列。
    而重排到 2 列会把每行炸开约 30 倍，冲爆 scrollback 上限被裁掉——20040 行实测只剩 678 行，
    **排回去也救不回来**。夹住一个非法值，比拒绝这次测量危险得多。
  */
  if (cols < MIN_FIT_COLS || rows < MIN_FIT_ROWS) return current;
  return { cols, rows };
}
