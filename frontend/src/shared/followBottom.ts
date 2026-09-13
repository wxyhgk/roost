/**
 * 「用户想不想跟着底部走」。
 *
 * **要点：解除跟随是一种权力，只有用户的动作有。**
 *
 * 滚动观察有两个来源，而它们长得一模一样：用户自己滚，和内容把视口顶走。后者到处都是
 * ——恢复一屏要灌几百行、代码高亮挂载后异步替换 `<pre>` 会改高度、图片加载同理、
 * 面板尺寸变化也会。把它们当成用户滚动，结果就是「新内容来了却不跟随」，而且此后再没人
 * 把他拉回底部：看起来就像用户在往回翻。终端上实测过这个症状——停在离底部 25 行的地方，
 * 最新输出在视野之外（issues/2026-09-10-restore-loses-rows-below-cursor.md 的第 4 条）。
 *
 * 所以：**只有可信的观察能解除跟随；到达底部则无条件恢复跟随**——真的滚到底了，
 * 那本身就是最明确的信号，不需要再问是谁造成的。
 */

export type FollowIntent = {
  /** 用户是否想跟着底部。新会话默认想。 */
  wantsBottom: boolean;
  /** 最近一次用户动作的时刻。滚动观察靠它判断是不是用户造成的。 */
  gestureAt: number;
};

export const initialFollowIntent: FollowIntent = { wantsBottom: true, gestureAt: -Infinity };

/**
 * 用户动作到滚动之间的归因窗口。
 *
 * 一次滚轮或拖拽会引出好几帧滚动观察，惯性滚动还会拖更久。窗口太短，用户滚了却解除不了
 * 跟随；太长，滚动刚过就来的内容抖动会被误判成用户动作。300ms 覆盖一次滚轮的连发和
 * 触控板惯性的头部，而内容抖动通常发生在与用户动作无关的时刻。
 */
export const GESTURE_WINDOW_MS = 300;

/** 用户做了一个可能引起滚动的动作（滚轮、拖拽、按键）。 */
export function afterGesture(intent: FollowIntent, at: number): FollowIntent {
  return { ...intent, gestureAt: at };
}

/** 收到一次滚动观察。 */
export function afterScroll(intent: FollowIntent, atBottom: boolean, at: number): FollowIntent {
  // 到了底部就恢复跟随，不问是谁造成的——到达底部本身就是最明确的意图。
  if (atBottom) return intent.wantsBottom ? intent : { ...intent, wantsBottom: true };
  // 离开底部：只有用户刚动过手，才算他要离开。
  const trusted = at - intent.gestureAt <= GESTURE_WINDOW_MS;
  if (!trusted || !intent.wantsBottom) return intent;
  return { ...intent, wantsBottom: false };
}

/** 显式命令（点「跳到底部」）：无条件恢复跟随，绕过一切判断。 */
export function afterExplicitJump(intent: FollowIntent): FollowIntent {
  return intent.wantsBottom ? intent : { ...intent, wantsBottom: true };
}

/**
 * 这次按键是不是在滚视口。
 *
 * **打字不是滚动。** 终端的视口靠滚轮和拖拽滚，键盘里只有 Shift+PageUp 那一类才滚视口，
 * 其余按键都是送给 PTY 的。把每次 keydown 都当成「用户要离开底部」的授权，等于打字期间
 * 任何一次内容抖动都可能被误判成用户翻页。
 */
export function isViewportScrollKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey">): boolean {
  if (event.ctrlKey || event.metaKey) return false;
  if (!event.shiftKey) return false;
  return event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End";
}
