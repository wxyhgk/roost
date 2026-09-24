import test from 'node:test';
import assert from 'node:assert/strict';
import { clampToViewport, cascadeRect, resizeRect, raise, reflow, maximizedRect,
  KEEP_VISIBLE, MIN_WIDTH, MIN_HEIGHT, TITLE_BAR, type Rect } from '../src/features/windows/geometry.ts';

const viewport = { width: 1200, height: 800 };
const rect = (x: number, y: number, width = 400, height = 300): Rect => ({ x, y, width, height });

/*
  裁剪。这一组全部围绕同一件事：**窗口永远要抓得住**。
  这里的每一条失败，表现都不是报错，而是某个窗口再也拿不回来。
*/
test('标题栏不能被顶到上边界以上——那是唯一不可逆的方向', () => {
  /*
    左右和下方都可逆：窗口露一条边在外面，拖回来就是了。**上方不行**：标题栏一旦
    越过 y=0，鼠标够不到它，页面也没有滚动条能把它拉回来，只能清 localStorage。
  */
  assert.equal(clampToViewport(rect(100, -500), viewport).y, 0);
  assert.equal(clampToViewport(rect(100, -1), viewport).y, 0);
});

test('窗口可以沉到底边只剩标题栏,但不能整个沉下去', () => {
  // 沉到底边是有用的（相当于最小化到底边）且可逆，所以允许；整个沉下去就抓不住了。
  assert.equal(clampToViewport(rect(100, 5000), viewport).y, viewport.height - TITLE_BAR);
});

test('左右可以露在外面,但至少留下能抓住的一截', () => {
  const left = clampToViewport(rect(-5000, 100), viewport);
  assert.equal(left.x, KEEP_VISIBLE - left.width, '往左拖到底时,右边还露着 KEEP_VISIBLE');
  assert.equal(clampToViewport(rect(5000, 100), viewport).x, viewport.width - KEEP_VISIBLE);
});

test('视口比窗口还小时,窗口缩到视口大小而不是留在外面', () => {
  // 手机横屏转竖屏会走到这里。夹住之后 x/y 的上下界可能交叉,clamp 的顺序要保证不出负数窗口。
  const tiny = clampToViewport(rect(300, 300, 900, 700), { width: 400, height: 320 });
  assert.equal(tiny.width, 400);
  assert.equal(tiny.height, 320);
});

test('视口小于最小尺寸时,不把窗口压到不可用', () => {
  /*
    宁可让窗口比视口大（还能拖着看），也不要压成一条缝。变异测试发现:
    把 `Math.max(MIN_WIDTH, …)` 去掉时,极窄视口下窗口宽度会变成 0。
  */
  const squeezed = clampToViewport(rect(0, 0, 400, 300), { width: 50, height: 40 });
  assert.equal(squeezed.width, MIN_WIDTH);
  assert.equal(squeezed.height, MIN_HEIGHT);
});

/* 新窗口开在哪儿。 */
test('新窗口不和已有窗口完全重合——重合看起来就是「点了没反应」', () => {
  const first = cascadeRect([], viewport);
  const second = cascadeRect([first], viewport);
  assert.notDeepEqual([second.x, second.y], [first.x, first.y]);
  const third = cascadeRect([first, second], viewport);
  for (const taken of [first, second]) assert.notDeepEqual([third.x, third.y], [taken.x, taken.y]);
});

test('阶梯排满之后绕回起点,而不是一直往视口外排', () => {
  // 一直往外排的结果是第 N 个窗口开在屏幕外面,人以为没打开。
  const many = Array.from({ length: 200 }, (_, i) => rect(TITLE_BAR * i, TITLE_BAR * i));
  const next = cascadeRect(many, viewport);
  assert.ok(next.x >= KEEP_VISIBLE - next.width && next.x <= viewport.width - KEEP_VISIBLE);
  assert.ok(next.y >= 0 && next.y <= viewport.height - TITLE_BAR);
});

test('视口极小时也要给出一个窗口,不能除以零', () => {
  const only = cascadeRect([], { width: 100, height: 80 });
  assert.ok(Number.isFinite(only.x) && Number.isFinite(only.y));
  assert.equal(only.width, MIN_WIDTH);
});

/* 缩放。 */
test('从右下角放大', () => {
  const next = resizeRect(rect(100, 100), 'se', 50, 40, viewport);
  assert.deepEqual([next.x, next.y, next.width, next.height], [100, 100, 450, 340]);
});

test('从左边缩放时原点跟着动,对边不动', () => {
  const before = rect(100, 100);
  const next = resizeRect(before, 'w', 60, 0, viewport);
  assert.equal(next.width, 340);
  assert.equal(next.x, 160);
  assert.equal(next.x + next.width, before.x + before.width, '右边必须钉住');
});

test('从左边缩过头时,窗口不会继续往右跑', () => {
  /*
    **天真写法在这里出错**：`width -= dx` 再夹一次最小值,而 x 仍然按未夹的 dx 移动,
    于是越过最小宽度之后左边还在推、右边跟着一起往右移——窗口自己跑掉了。
  */
  const before = rect(100, 100);
  const next = resizeRect(before, 'w', 5000, 0, viewport);
  assert.equal(next.width, MIN_WIDTH);
  assert.equal(next.x + next.width, before.x + before.width, '推过头之后右边仍然钉在原处');
});

test('从上边缩过头时同理,下边钉住', () => {
  const before = rect(100, 100);
  const next = resizeRect(before, 'n', 0, 5000, viewport);
  assert.equal(next.height, MIN_HEIGHT);
  assert.equal(next.y + next.height, before.y + before.height);
});

test('角上的缩放同时作用于两个方向', () => {
  const next = resizeRect(rect(200, 200), 'nw', 50, 30, viewport);
  assert.equal(next.width, 350);
  assert.equal(next.height, 270);
  assert.equal(next.x, 250);
  assert.equal(next.y, 230);
});

test('缩放结果也要过裁剪——不能靠缩放把窗口推出可达范围', () => {
  // 只在拖动时裁剪是不够的:从右边一路拉大同样能把窗口顶出去(变异测试发现)。
  const next = resizeRect(rect(1150, 100), 'e', 5000, 0, viewport);
  assert.ok(next.x <= viewport.width - KEEP_VISIBLE);
});

/* 层叠顺序。 */
test('提到最前:移到末尾,不重复,不改其他的相对顺序', () => {
  assert.deepEqual(raise(['a', 'b', 'c'], 'a'), ['b', 'c', 'a']);
  assert.deepEqual(raise(['a', 'b', 'c'], 'c'), ['a', 'b', 'c'], '已经在最前时不动');
});

test('提一个不存在的 id 不会把它插进去', () => {
  // 调用方可能拿着一个已经关掉的窗口 id（一次迟到的点击）。凭空插入会画出一个空窗口。
  assert.deepEqual(raise(['a', 'b'], 'gone'), ['a', 'b']);
});

/* 视口变化。 */
test('视口变小之后,所有窗口重新收回可达范围', () => {
  const windows = [{ id: 'a', rect: rect(1000, 700) }, { id: 'b', rect: rect(10, 10) }];
  const after = reflow(windows, { width: 400, height: 300 });
  for (const window of after) {
    assert.ok(window.rect.y >= 0 && window.rect.y <= 300 - TITLE_BAR, `${window.id} 的标题栏仍然够得着`);
  }
  assert.equal(after[1]!.id, 'b', '顺序和 id 不变,只改几何');
});

test('最大化铺满视口', () => {
  assert.deepEqual(maximizedRect(viewport), { x: 0, y: 0, width: 1200, height: 800 });
});
