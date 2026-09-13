import assert from "node:assert/strict";
import { test } from "node:test";
import { pointToCell, selectionArgs } from "../src/features/terminal/touchSelect.ts";

// 一个 80x24 的终端，内容区 800x480，于是每格 10x20。
const rect = { left: 100, top: 50, width: 800, height: 480 };
const view = { cols: 80, rows: 24, viewportY: 0 };

test("触点落到对应单元格，行号是绝对缓冲区行而不是屏幕行", () => {
  assert.deepEqual(pointToCell(100, 50, rect, view), { col: 0, row: 0 }, "左上角");
  assert.deepEqual(pointToCell(115, 95, rect, view), { col: 1, row: 2 });
  assert.deepEqual(pointToCell(899, 529, rect, view), { col: 79, row: 23 }, "右下角最后一格");

  // 已经滚上去 1000 行时，同一个触点属于另一段历史——用屏幕行会选错文本。
  assert.deepEqual(pointToCell(115, 95, rect, { ...view, viewportY: 1000 }), { col: 1, row: 1002 });
});

test("越界收敛到最近的单元格，而不是判为无效", () => {
  // 点在行尾右侧的空白处，意图显然是「选到这一行末尾」。
  assert.deepEqual(pointToCell(5000, 95, rect, view), { col: 79, row: 2 });
  assert.deepEqual(pointToCell(-40, 95, rect, view), { col: 0, row: 2 });
  assert.deepEqual(pointToCell(115, -100, rect, view), { col: 1, row: 0 });
  assert.deepEqual(pointToCell(115, 5000, rect, view), { col: 1, row: 23 });
});

test("量不出尺寸时才返回 null", () => {
  assert.equal(pointToCell(100, 50, { ...rect, width: 0 }, view), null);
  assert.equal(pointToCell(100, 50, { ...rect, height: 0 }, view), null);
  assert.equal(pointToCell(100, 50, rect, { ...view, cols: 0 }), null);
});

test("同一个格子选中一个字符，不是零个", () => {
  assert.deepEqual(selectionArgs({ col: 3, row: 7 }, { col: 3, row: 7 }, 80), { col: 3, row: 7, length: 1 });
});

test("反向选择自动对调，结果与正向一致", () => {
  const forward = selectionArgs({ col: 2, row: 5 }, { col: 9, row: 5 }, 80);
  const backward = selectionArgs({ col: 9, row: 5 }, { col: 2, row: 5 }, 80);
  assert.deepEqual(forward, { col: 2, row: 5, length: 8 });
  assert.deepEqual(backward, forward, "从后往前划必须得到同一个范围");

  // 跨行的反向同理：行号更小的那个才是起点。
  assert.deepEqual(
    selectionArgs({ col: 1, row: 9 }, { col: 4, row: 6 }, 80),
    selectionArgs({ col: 4, row: 6 }, { col: 1, row: 9 }, 80),
  );
});

test("跨行长度按每行 cols 个单元格累加，两端都算在内", () => {
  // 从 (col 78, row 3) 到 (col 1, row 5)：本行剩 2 格 + 整行 80 + 下一行 2 格。
  assert.deepEqual(selectionArgs({ col: 78, row: 3 }, { col: 1, row: 5 }, 80), { col: 78, row: 3, length: 84 });
  // 整整一行。
  assert.deepEqual(selectionArgs({ col: 0, row: 2 }, { col: 79, row: 2 }, 80), { col: 0, row: 2, length: 80 });
});
