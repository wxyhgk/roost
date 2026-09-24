/**
 * 让给浏览器、不送进终端的组合键。**两个平台的名单必须分开**。
 *
 * macOS 上复制粘贴和浏览器快捷键都走 ⌘，终端走 Ctrl，两者天然不打架，
 * 所以整份 ⌘ 快捷键都可以放行。
 *
 * Windows / Linux 上没有这层分隔：浏览器快捷键和终端控制键抢的是同一个 Ctrl。
 * 这时必须逐个判断谁更该赢，而不是照抄 macOS 那份——照抄的结果就是
 * Ctrl+L（清屏）、Ctrl+R（反向搜索历史）这些终端命脉被交给了地址栏和刷新。
 * 留在名单里的只有两类：浏览器**根本不让网页拦截**的（新标签/新窗口/关标签，
 * 拦不住还不如明说），以及缩放和切标签这些本来就不是终端键的。
 */
const MAC_BROWSER_CMD = new Set([
  "KeyR",
  "KeyT",
  "KeyN",
  "KeyW",
  "KeyL",
  "KeyQ",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Equal",
  "Minus",
  "NumpadAdd",
  "NumpadSubtract",
]);

// KeyL 与 KeyR 不在此列：终端里它们是清屏和反向搜索历史，比地址栏和刷新重要得多，
// 而且浏览器允许网页拦截它们。刷新仍有 F5。
// KeyT / KeyN / KeyW / KeyQ 留着：这些浏览器不交出来，硬抢只会两头落空。
const OTHER_BROWSER_CMD = new Set([...MAC_BROWSER_CMD].filter(code => code !== "KeyL" && code !== "KeyR"));

export function isMac() {
  return /mac|iphone|ipad/i.test(navigator.platform);
}

/**
 * 「按住它再点 = 打开链接」的那个键。
 *
 * 和 `isMac` 放在一起，因为问的是同一件事：这个平台上「打开」是 ⌘ 还是 Ctrl。终端里有两种
 * 链接（网址、文件路径），各自的打开逻辑在不同文件里——这个判断抄成两份，改了一处忘了另一处
 * 就会变成「网址要 ⌘、路径要 Ctrl」，而用户看到的提示只有一条。
 */
export function linkModifier(ev: MouseEvent) {
  return isMac() ? ev.metaKey : ev.ctrlKey;
}

export function isBrowserShortcut(ev: KeyboardEvent) {
  if (ev.isComposing || ev.keyCode === 229) return false;
  if (isMac()) {
    if (!ev.metaKey || ev.ctrlKey || ev.altKey) return false;
    return MAC_BROWSER_CMD.has(ev.code);
  }
  if (!ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  return OTHER_BROWSER_CMD.has(ev.code);
}

export function attachBrowserShortcutPassthrough(host: HTMLElement) {
  const onKeyDown = (ev: KeyboardEvent) => {
    if (!isBrowserShortcut(ev)) return;
    ev.stopImmediatePropagation();
  };
  host.addEventListener("keydown", onKeyDown, { capture: true });
  return () =>
    host.removeEventListener("keydown", onKeyDown, { capture: true });
}
