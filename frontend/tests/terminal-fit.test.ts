import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitSize, MIN_FIT_COLS, MIN_FIT_ROWS } from '../src/features/terminal/engine/fit';

const CELL = { width: 7.8, height: 17 };   // IBM Plex Mono @13px, 约当实际值
const GUTTER = 14;                          // 有 scrollback 时留给滚动条的宽度
const CURRENT = { cols: 120, rows: 40 };

test('a normal container produces a grid that fits inside it', () => {
  const { cols, rows } = fitSize({ width: 960, height: 700 }, CELL, GUTTER, CURRENT);
  assert.equal(cols, Math.floor((960 - GUTTER - 1) / CELL.width));
  assert.equal(rows, Math.floor((700 - 1) / CELL.height));
  assert.ok(cols * CELL.width + GUTTER <= 960);
});

/*
  这条守的是一次不可逆的数据损失。

  旧写法是 `clientWidth <= 4` 一道门，加上 `Math.max(2, …)` 兜底。gutter 就有 14 像素，
  所以宽度落在 5 到约 30 之间会穿过门、算出负数、被夹成 2 列——而重排到 2 列会把每行
  炸开约 30 倍，冲爆 scrollback 上限被裁掉，**排回去也救不回来**（实测 20040 行剩 678 行）。

  所以：量不出一个像样的网格时，必须原样返回当前尺寸，绝不能夹一个非法值出去。
*/
test('an untrustworthy measurement keeps the current grid instead of clamping to a floor', () => {
  for (const width of [0, 1, 5, 15, 20, 30]) {
    const result = fitSize({ width, height: 700 }, CELL, GUTTER, CURRENT);
    assert.deepEqual(result, CURRENT, `width ${width} must be refused, not clamped`);
  }
  for (const height of [0, 1, 17, 50]) {
    assert.deepEqual(fitSize({ width: 960, height }, CELL, GUTTER, CURRENT), CURRENT);
  }
});

test('the refusal threshold sits below any real panel width', () => {
  // 手机竖屏下中间栏也有 300 像素上下——那必须能正常算出尺寸。
  const { cols } = fitSize({ width: 300, height: 500 }, CELL, GUTTER, CURRENT);
  assert.ok(cols >= MIN_FIT_COLS, `300px should fit a usable grid, got ${cols}`);
  assert.notDeepEqual(fitSize({ width: 300, height: 500 }, CELL, GUTTER, CURRENT), CURRENT);
});

test('a zero cell size is refused rather than dividing by zero', () => {
  assert.deepEqual(fitSize({ width: 960, height: 700 }, { width: 0, height: 17 }, GUTTER, CURRENT), CURRENT);
  assert.deepEqual(fitSize({ width: 960, height: 700 }, { width: 7.8, height: 0 }, GUTTER, CURRENT), CURRENT);
});

test('the floors are the ones the engine relies on', () => {
  assert.equal(MIN_FIT_COLS, 20);
  assert.equal(MIN_FIT_ROWS, 4);
});

/*
  滚动条让多了，右边就白空掉一整列。

  数字取自一台真机的诊断读数（2026-09-16）：`box=1068x845 cell=7.8x17 grid=135x49
  painted=1053`——1068 减 1053 是 15 像素的空白，差不多两格宽。而 xterm 6 的滚动条是
  浮在内容上的，CSS 把它画成 6px，从来不需要 14。

  剩下的那点零头（不足一格）是 `Math.floor` 的必然，修不掉也不该修：显示半列比空着更糟。
*/
test('滚动条只让它真实的宽度，不多让', () => {
  const box = { width: 1068, height: 845 };
  const generous = fitSize(box, CELL, 14, CURRENT);
  const exact = fitSize(box, CELL, 6, CURRENT);
  assert.equal(generous.cols, 135, '这是改之前的实测值');
  assert.equal(exact.cols, 136, '让 6 应该多站得下一列');
  // 让出去的宽度仍然够滚动条站，字不会被压在底下。
  assert.ok(exact.cols * CELL.width + 6 <= box.width);
});
