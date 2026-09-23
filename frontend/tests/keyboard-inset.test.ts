import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYBOARD_INSET_MAX_WIDTH,
  KEYBOARD_INSET_MIN_PX,
  isEditableTarget,
  resolveKeyboardInset,
  type KeyboardInsetInput,
} from '../src/shared/keyboardInset';

/*
  软键盘遮住发信框这件事只能这么验：本仓前端测试没有 jsdom，而真机截图验不了 80px 这种边界值，
  更验不了 iOS 那条 `offsetTop` 的自平衡——它的症状是「顶过头」，截图上和「没顶」长得不一样，
  但和「顶对了」差多少像素，肉眼说不清。

  背景在 src/shared/keyboardInset.ts 顶上：这个数只给发信框用，终端容器的高度一个像素都不能动。
*/

/** iPhone 14 竖屏：布局视口 390x844。默认是「聚焦了输入框、键盘没弹」这个状态。 */
function phone(over: Partial<KeyboardInsetInput> = {}): KeyboardInsetInput {
  return { layoutHeight: 844, visualHeight: 844, visualOffsetTop: 0, viewportWidth: 390, editableFocused: true, ...over };
}

test('键盘弹起：让出的正是被盖住的那一段', () => {
  // 844 的布局视口，键盘吃掉 300 之后还剩 544。
  assert.equal(resolveKeyboardInset(phone({ visualHeight: 544 })), 300);
});

test('键盘没弹时不让位', () => {
  assert.equal(resolveKeyboardInset(phone()), 0);
});

test('iOS 把视口往上顶了多少，就从要让的高度里扣掉多少', () => {
  /*
    Safari 除了缩 visual viewport 还会把它往上滚，好让聚焦的输入框露出来。
    浏览器顶了 24，键盘高 280（844 - 564 - 24 = 256 还得我们自己顶）。
    少了 offsetTop 这一项，这里会算成 280，两边叠加把发信框推出屏幕。
  */
  assert.equal(resolveKeyboardInset(phone({ visualHeight: 564, visualOffsetTop: 24 })), 256);

  // 自平衡的另一头：浏览器已经顶满，我们就一点都不用顶。
  assert.equal(resolveKeyboardInset(phone({ visualHeight: 544, visualOffsetTop: 300 })), 0);
});

test('没有可编辑元素聚焦 → 一律 0，底下那块不是键盘', () => {
  // 同样的几何，只差焦点。iOS 的橡皮筋回弹、地址栏收放都长这样。
  assert.equal(resolveKeyboardInset(phone({ visualHeight: 544, editableFocused: false })), 0);
});

test('桌面宽度一律 0 —— 把窗口拉矮不是键盘', () => {
  for (const viewportWidth of [KEYBOARD_INSET_MAX_WIDTH, 820, 1024, 1920]) {
    assert.equal(resolveKeyboardInset(phone({ viewportWidth, visualHeight: 544 })), 0, `${viewportWidth} 不该让位`);
  }
  // 阈值是开区间的下界：差一像素就还算手机。
  assert.equal(resolveKeyboardInset(phone({ viewportWidth: KEYBOARD_INSET_MAX_WIDTH - 1, visualHeight: 544 })), 300);
});

test('小于 80px 的变化当作浏览器 chrome 忽略', () => {
  // iOS 滚动时收起／展开地址栏就是这个量级。没有下限的话，随便滚一下发信框就跳一次。
  const justUnder = phone({ visualHeight: 844 - (KEYBOARD_INSET_MIN_PX - 1) });
  assert.equal(resolveKeyboardInset(justUnder), 0);
  // 刚到门槛就算数——边界值只能这么验。
  assert.equal(resolveKeyboardInset(phone({ visualHeight: 844 - KEYBOARD_INSET_MIN_PX })), KEYBOARD_INSET_MIN_PX);
});

test('非有限值不许流进 CSS', () => {
  /*
    一个 NaN 的 padding 在 React 里不会报错，只会让整条样式静默失效。
    标签页在后台、页面刚加载时 visualViewport 读出来是什么，各家实现并不一致。
  */
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveKeyboardInset(phone({ visualHeight: bad })), 0, `visualHeight=${bad}`);
    assert.equal(resolveKeyboardInset(phone({ visualHeight: 544, visualOffsetTop: bad })), 0, `offsetTop=${bad}`);
    assert.equal(resolveKeyboardInset(phone({ layoutHeight: bad, visualHeight: 544 })), 0, `layoutHeight=${bad}`);
  }
});

test('缩放后的小数高度取整，不带出亚像素抖动', () => {
  assert.equal(resolveKeyboardInset(phone({ visualHeight: 544.4 })), 300);
  assert.equal(resolveKeyboardInset(phone({ visualHeight: 543.6 })), 300);
});

test('会唤起键盘的元素：textarea、文本类 input、contenteditable', () => {
  const target = (tagName: string | null, inputType: string | null = null, isContentEditable = false) =>
    isEditableTarget({ tagName, inputType, isContentEditable });

  assert.equal(target('TEXTAREA'), true);
  assert.equal(target('DIV', null, true), true, 'contenteditable 的 div 会唤起键盘');
  // type 缺省、或者写了个认不出的词，浏览器都按 text 处理。
  for (const type of [null, 'text', 'search', 'email', 'url', 'tel', 'number', 'password', 'nonsense']) {
    assert.equal(target('INPUT', type), true, `input[type=${type}] 该算`);
  }
  // iOS 上这些唤起的是滚轮选择器：不是键盘，但同样从底下升起、同样缩小 visual viewport。
  for (const type of ['date', 'time', 'datetime-local', 'month', 'week']) {
    assert.equal(target('INPUT', type), true, `input[type=${type}] 的选择器一样遮挡`);
  }
  assert.equal(target('INPUT', 'TEXT'), true, 'type 比较不分大小写');
});

test('不唤起键盘的元素：按钮、复选框、滑块，以及没有聚焦元素', () => {
  const target = (tagName: string | null, inputType: string | null = null, isContentEditable = false) =>
    isEditableTarget({ tagName, inputType, isContentEditable });

  // 在这些控件上点一下，屏幕底下什么都不会升起来——算成聚焦就会让发信框凭空顶起一截。
  for (const type of ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']) {
    assert.equal(target('INPUT', type), false, `input[type=${type}] 不该算`);
  }
  assert.equal(target('INPUT', 'RADIO'), false, '大小写不同也要排除');
  assert.equal(target('BUTTON'), false);
  assert.equal(target('DIV'), false);
  assert.equal(target(null), false, '没有聚焦元素');
});
