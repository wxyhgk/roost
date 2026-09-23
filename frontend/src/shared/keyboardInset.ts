/**
 * 「软键盘此刻遮住了屏幕底下多少像素」。
 *
 * **这个数只许给发信框那一侧用，终端容器的高度一个像素都不能动。**
 * `FitAddon.proposeDimensions()` 读的是父容器的计算高度：容器一矮、跨过一个格子边界就是一次
 * 真 `fit` → PTY resize → **SIGWINCH**，而 `tasks/terminal-flood/README.md` 写着 omp 收到
 * SIGWINCH 会把整段对话重新打印一遍。键盘开一次关一次就是两轮刷屏。所以显示区跟
 * `visualViewport.height` 走、PTY 的 cols/rows 跟 `innerHeight` 走——遮挡靠让出空间解决，
 * 不靠改终端尺寸解决。同一条约束在 `NarrowDrawer.tsx` 和 `session/resizeGate.ts` 上都写过。
 *
 * **抽成纯函数是为了能测**：本仓前端测试没有 jsdom，逻辑留在组件里就只能靠真机截图验，
 * 而截图验不了 80px 这种边界值，也验不了 iOS 那条 `offsetTop` 的自平衡。
 *
 * 公式移植自 `research/third-party/happier`（Claude Code 的移动端客户端，同一个问题）：
 *
 *     inset = max(0, innerHeight - visualViewport.height - visualViewport.offsetTop)
 */

/**
 * 小于这个数当作浏览器 chrome 的变化忽略。
 *
 * iOS Safari 滚动时会收起／展开地址栏和底栏，那一下同样会缩小 visual viewport，几十像素。
 * 没有下限的话，随便滚一下页面发信框就跳一次。真实软键盘没有这么矮（最窄的中文九宫格也在
 * 200px 以上），所以 80 这个门槛两边都不挨着，不会误判也不会漏判。
 */
export const KEYBOARD_INSET_MIN_PX = 80;

/**
 * 视口宽到这个数就当没有软键盘。
 *
 * **刻意不复用 `narrow.ts` 的 820**：那个数回答的是「并排排得下几段面板」，这个数回答的是
 * 「这块屏幕会从底下升起一块键盘吗」。两个问题恰好都落在七八百像素附近纯属巧合，合用一个
 * 常量会让任何一边的调整误伤另一边。
 */
export const KEYBOARD_INSET_MAX_WIDTH = 768;

/** 判断「聚焦的这个元素会不会唤起软键盘」所需要的一切——只要三个字段，于是可以纯函数地测。 */
export type EditableTarget = Readonly<{
  /** `element.tagName`，大写，照 DOM 原样传进来。没有聚焦元素时传 `null`。 */
  tagName: string | null;
  /** `<input>` 的 `type`，其余元素传 `null`。 */
  inputType: string | null;
  /** `element.isContentEditable`。 */
  isContentEditable: boolean;
}>;

/*
  这些 input 类型不唤起软键盘：点一下复选框、按一下按钮、拖一下滑块，屏幕底下什么都不会升起来。
  把它们算成「聚焦了可编辑元素」，在这些控件上点一下就会让发信框凭空顶起一截。

  反过来，`date` / `time` 一类在 iOS 上唤起的是滚轮选择器——它不是键盘，但**同样从底下升起、
  同样缩小 visual viewport**。所以它们留在名单外（＝算作会遮挡），让公式自己去量。
*/
const NON_KEYBOARD_INPUT_TYPES = new Set([
  "button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit",
]);

/** 聚焦的这个元素会不会唤起软键盘。 */
export function isEditableTarget(target: EditableTarget): boolean {
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  // `type` 缺省是 `text`；`type` 写了个认不出的词，浏览器也按 `text` 处理。
  return !NON_KEYBOARD_INPUT_TYPES.has((target.inputType ?? "text").toLowerCase());
}

export type KeyboardInsetInput = Readonly<{
  /** `window.innerHeight`：**布局**视口的高。键盘弹起时它不变，这正是公式的基准。 */
  layoutHeight: number;
  /** `visualViewport.height`：键盘弹起后肉眼还能看到的那一块。 */
  visualHeight: number;
  /** `visualViewport.offsetTop`：浏览器已经替我们往上顶了多少，见下面的说明。 */
  visualOffsetTop: number;
  /** 视口宽度，用来排除桌面。 */
  viewportWidth: number;
  /** 当前聚焦的是不是会唤起软键盘的元素。 */
  editableFocused: boolean;
}>;

/**
 * 算出发信框底下要让出多少像素。返回 0 表示不用让。
 *
 * **`offsetTop` 那一项是为了 iOS，而且这条公式是自平衡的**：Safari 除了缩小 visual viewport，
 * 还会把它整个往上滚一段，好让聚焦的输入框露出来。浏览器自己顶了多少，我们就从要让出的高度里
 * 扣掉多少——它顶满了（`offsetTop` 等于键盘高）我们就不用顶，它一点没顶我们就顶满。少了这一项，
 * 两边会叠加，发信框被推到屏幕外面去。
 */
export function resolveKeyboardInset(input: KeyboardInsetInput): number {
  // 没有可编辑元素聚焦，底下那块就不是键盘——是 iOS 的橡皮筋回弹、是地址栏、是别的什么。
  if (!input.editableFocused) return 0;
  // 桌面浏览器把窗口拉矮也会让差值变大，那不是键盘。宽度是这里唯一靠得住的分辨依据。
  if (input.viewportWidth >= KEYBOARD_INSET_MAX_WIDTH) return 0;

  /*
    非有限值一律当 0 处理，不要让 NaN 流到 CSS 里去。
    visualViewport 在页面刚加载、或者标签页在后台时读出来是什么，各家实现并不一致；
    而一个 NaN 的 padding 在 React 里不会报错，只会让整条样式静默失效——那种 bug 最难找。
  */
  const { layoutHeight, visualHeight, visualOffsetTop } = input;
  if (!Number.isFinite(layoutHeight) || !Number.isFinite(visualHeight) || !Number.isFinite(visualOffsetTop)) return 0;

  const inset = Math.max(0, layoutHeight - visualHeight - visualOffsetTop);
  if (inset < KEYBOARD_INSET_MIN_PX) return 0;
  // 取整：visualViewport 的高在缩放后是小数，直接进 CSS 会带出亚像素抖动。
  return Math.round(inset);
}
