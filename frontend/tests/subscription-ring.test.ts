/*
  额度环的弧。这段的失败方式全是**静悄悄画错**——不抛异常、不报错，只是画出一个和真实
  数值不符的形状。所以每条用例盯的都是一种「看起来没事」的错。
*/
import { equal, ok, match } from 'node:assert/strict';
import { test } from 'node:test';
import { RING, arcPath } from '../src/features/subscriptions/arc.ts';

const endpoint = (path: string) => path.split(' ').at(-1)!.split(',').map(Number);
/* `M10,1.5A8.5,8.5 0 1 1 9.47,18.48` —— 空格切开之后是
   [半径段, x轴旋转, 大弧标志, 顺时针标志, 终点]，大弧在第 2 位不是第 1 位。 */
const largeArc = (path: string) => Number(path.split(' ')[2]);
const sweep = (path: string) => Number(path.split(' ')[3]);

test('空和非法不画：空弧画成一个点，比不画更难看懂', () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) equal(arcPath(value), null);
});

test('25% 停在三点方向，75% 停在九点方向——弧从十二点顺时针走', () => {
  const [x1, y1] = endpoint(arcPath(25)!);
  ok(Math.abs(x1 - (RING.center + RING.radius)) < 0.02 && Math.abs(y1 - RING.center) < 0.02, `25% 该在三点，实际 ${x1},${y1}`);
  const [x2, y2] = endpoint(arcPath(75)!);
  ok(Math.abs(x2 - (RING.center - RING.radius)) < 0.02 && Math.abs(y2 - RING.center) < 0.02, `75% 该在九点，实际 ${x2},${y2}`);
});

test('过半圈要置大弧标志，否则 87% 会被抄近路画成 13% 的样子而且不报错', () => {
  equal(largeArc(arcPath(25)!), 0);
  equal(largeArc(arcPath(50)!), 0, '正好半圈不算大弧');
  equal(largeArc(arcPath(51)!), 1);
  equal(largeArc(arcPath(87)!), 1);
  equal(largeArc(arcPath(100)!), 1);
});

test('顺时针标志必须是 1：画反了 25% 会长得和 75% 一模一样，端点却完全正确', () => {
  for (const value of [1, 25, 50, 87, 100]) equal(sweep(arcPath(value)!), 1);
});

test('100% 仍然画得出来：终点不许和起点重合，否则浏览器整段不画，满格的环凭空消失', () => {
  const full = arcPath(100)!;
  const [x, y] = endpoint(full);
  ok(Math.hypot(x - RING.center, y - (RING.center - RING.radius)) > 0, '终点和起点重合了');
  ok(Math.abs(x - RING.center) < 0.02 && y < RING.center, '终点该几乎回到十二点');
  equal(arcPath(150), full, '超过 100 和 100 画一样，不绕第二圈');
});

test('起点永远是十二点，半径和圆心跟着 RING 走', () => {
  match(arcPath(40)!, new RegExp(`^M${RING.center},${RING.center - RING.radius}A${RING.radius},${RING.radius} `));
  ok(RING.center + RING.radius + RING.stroke / 2 <= RING.size, '环加描边不能超出 viewBox');
});
