import assert from 'node:assert/strict';
import { test } from 'node:test';
import { squareViewBox } from '../src/shared/ui/cli-animation/index.tsx';

/*
  这两份 Lottie 的画布是 1080×1080，而 logo 只占中间约 35%，所以要按内容真实边界重设
  viewBox——否则 28px 的槽位里动画只有十来个像素，比旁边的静态图标小一圈。

  撑成正方形这一步单独测：槽位是方的，拿非方形的包围盒直接当 viewBox 会把 logo 拉变形，
  而那种错在小尺寸下很不容易一眼看出来。
*/
test('正方形包围盒原样返回', () => {
  assert.deepEqual(squareViewBox({ x: 10, y: 20, right: 110, bottom: 120 }), { x: 10, y: 20, size: 100 });
});

test('扁的按宽度取，上下各补一半', () => {
  // 200 宽、100 高 → 边长 200，纵向两侧各补 50
  assert.deepEqual(squareViewBox({ x: 0, y: 0, right: 200, bottom: 100 }), { x: 0, y: -50, size: 200 });
});

test('高的按高度取，左右各补一半', () => {
  assert.deepEqual(squareViewBox({ x: 0, y: 0, right: 100, bottom: 200 }), { x: -50, y: 0, size: 200 });
});

test('负坐标也成立——Lottie 的内容常常跨过原点', () => {
  assert.deepEqual(squareViewBox({ x: -180, y: -199, right: 193, bottom: 169 }), { x: -180, y: -201.5, size: 373 });
});
