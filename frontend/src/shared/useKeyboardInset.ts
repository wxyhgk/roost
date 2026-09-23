import { useEffect, useState } from "react";
import { isEditableTarget, resolveKeyboardInset } from "./keyboardInset";

/**
 * 订阅「软键盘此刻遮住了底下多少像素」。判据、阈值和那条 `offsetTop` 的理由都在 `keyboardInset.ts`。
 *
 * **只给发信框那一侧用。** 拿它去改终端容器的高度，就是 `keyboardInset.ts` 顶上那段说的
 * `fit` → PTY resize → SIGWINCH → 整段对话重打印。
 *
 * **必须听四个事件，一个都不能省**：
 *
 * - `visualViewport` 的 `resize` —— 键盘升起／收起的主路径。
 * - `visualViewport` 的 `scroll` —— iOS 上存在只发 scroll 不发 resize 的情形：Safari 为了让
 *   输入框露出来把 visual viewport 往上滚，高度没变、`offsetTop` 变了。公式里扣的就是这一项，
 *   不听 scroll 就会漏掉它，发信框被顶过头。
 * - `window` 的 `focusin` / `focusout` —— 键盘高度不变、焦点从输入框挪到别处时（比如点了终端），
 *   viewport 事件可能一个都不发，但答案已经从「要让」变成「不用让」了。
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const viewport = window.visualViewport;
    /*
      没有 visualViewport 就恒为 0。**不要退回去用 innerHeight 的差值猜**：布局视口在键盘弹起时
      本来就不变，那个差值量到的是地址栏，不是键盘。宁可不顶，也不要顶错。
    */
    if (!viewport) return;

    let frame = 0;
    const apply = () => {
      frame = 0;
      const active = document.activeElement as HTMLElement | null;
      setInset(resolveKeyboardInset({
        layoutHeight: window.innerHeight,
        visualHeight: viewport.height,
        visualOffsetTop: viewport.offsetTop,
        viewportWidth: viewport.width,
        editableFocused: active !== null && isEditableTarget({
          tagName: active.tagName,
          inputType: active instanceof HTMLInputElement ? active.type : null,
          isContentEditable: active.isContentEditable === true,
        }),
      }));
    };
    /*
      合并到下一帧再算，有两个理由，都不是「为了性能」：

      1. 键盘动画期间 `resize` 和 `scroll` 会连着发几十次，每次都 setState 就是几十次重排，
         发信框会跟着抖。
      2. 焦点在两个输入框之间移动时，`focusout` 先于 `focusin`，中间那一瞬 `document.activeElement`
         是 `<body>`。当场算就会读到「没有聚焦」→ inset 归零 → 下一帧又弹回来，闪一下。
         等到下一帧，焦点已经落定了。
    */
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(apply); };

    apply();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
    };
  }, []);

  return inset;
}
