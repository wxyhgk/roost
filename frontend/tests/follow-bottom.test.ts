import { test } from "node:test";
import assert from "node:assert/strict";
import { afterExplicitJump, afterGesture, afterScroll, initialFollowIntent, isViewportScrollKey, GESTURE_WINDOW_MS } from "../src/shared/followBottom.ts";

/*
  滚动观察有两个来源，长得一模一样：用户自己滚，和内容把视口顶走。后者到处都是——
  恢复灌几百行、代码高亮挂载后替换 <pre> 改高度、图片加载、面板尺寸变化。
  **把内容抖动当成用户滚动，就等于把一个没滚动的人永久解除跟随。**
*/
test("content churn cannot unpin a user who never scrolled", () => {
  let intent = initialFollowIntent;
  for (const t of [0, 10, 20, 500, 1000]) intent = afterScroll(intent, false, t);
  assert.equal(intent.wantsBottom, true, "没有用户动作，视口被内容顶走不算他要离开");
});

test("a scroll right after a user gesture does unpin", () => {
  let intent = afterGesture(initialFollowIntent, 1000);
  intent = afterScroll(intent, false, 1000 + GESTURE_WINDOW_MS);
  assert.equal(intent.wantsBottom, false);
});

/* 归因窗口之外的观察不再算在那次动作头上，否则用户滚一次就把之后的抖动全认领了。 */
test("a scroll long after the gesture is no longer attributed to it", () => {
  let intent = afterGesture(initialFollowIntent, 1000);
  intent = afterScroll(intent, false, 1000 + GESTURE_WINDOW_MS + 1);
  assert.equal(intent.wantsBottom, true);
});

/* 真的滚到底了，那本身就是最明确的意图——不需要再问是谁造成的。 */
test("reaching the bottom re-arms following whatever caused it", () => {
  let intent = afterGesture(initialFollowIntent, 0);
  intent = afterScroll(intent, false, 0);
  assert.equal(intent.wantsBottom, false);
  intent = afterScroll(intent, true, 5000);      // 内容变短把视口带到底，也算
  assert.equal(intent.wantsBottom, true);
});

test("an explicit jump pins regardless of gesture attribution", () => {
  let intent = afterGesture(initialFollowIntent, 0);
  intent = afterScroll(intent, false, 0);
  assert.equal(afterExplicitJump(intent).wantsBottom, true);
});

/* 不变的输入不该产生新对象：它会驱动 React 状态，每次都换引用就会多渲染一轮。 */
test("an observation that changes nothing returns the same object", () => {
  const intent = initialFollowIntent;
  assert.equal(afterScroll(intent, true, 0), intent);
  assert.equal(afterScroll(intent, false, 9999), intent);
  assert.equal(afterExplicitJump(intent), intent);
});

/*
  **打字不是滚动。** 终端里键盘只有 Shift+PageUp 那一类滚视口，其余按键都送给 PTY。
  把每次 keydown 都当成解除跟随的授权，等于打字期间任何一次内容抖动都可能被误判。
*/
test("typing is not a scroll gesture, but shift-paging is", () => {
  const key = (k: string, shift = false, ctrl = false) => ({ key: k, shiftKey: shift, ctrlKey: ctrl, metaKey: false });
  for (const k of ["a", "Enter", "ArrowUp", "PageUp", "Home"]) assert.equal(isViewportScrollKey(key(k)), false, k);
  for (const k of ["PageUp", "PageDown", "Home", "End"]) assert.equal(isViewportScrollKey(key(k, true)), true, `Shift+${k}`);
  assert.equal(isViewportScrollKey(key("PageUp", true, true)), false, "带 Ctrl 的组合是别的意思");
});
