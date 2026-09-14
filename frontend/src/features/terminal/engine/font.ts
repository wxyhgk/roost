/**
 * 「什么时候量这个终端才算数」。
 *
 * 单独一个模块，是因为它**不能把 xterm 拖进来**——它守的那条规则值得有测试，
 * 而测试不该为了这几十行去加载一个浏览器渲染器。
 */
/*
  终端的字体栈。

  拉丁字形来自 IBM Plex Mono（index.html 里真的下载了的那一份）。CJK 那几个在**最后**，
  因为 IBM Plex Mono 没有 CJK，取不到就会落到浏览器默认的等宽字体——Windows 上那常常
  是宋体/新宋体，在终端里看着很旧。字体回退按**字形**发生，所以栈尾的 CJK 家族只画
  CJK，它们的 Latin 比例字形轮不到出场。

  **但上面那句只在「前面有一个真等宽字体可用」时成立，而 Windows 上一度不成立。**
  原来的栈是 `"IBM Plex Mono", ui-monospace, "PingFang SC", "Microsoft YaHei", …`：

  - IBM Plex Mono 走 Google Fonts，而**桌面版的 CSP 根本不允许它**
    （desktop/runtime/server.mjs 是 `style-src 'self' 'unsafe-inline'` + `font-src 'self' data:`，
    两个 fonts.* 域名都不在里面）；浏览器直连时它也可能因为网络取不到。
  - `ui-monospace` 只有 macOS 的 WebKit/Chromium 认，Windows 上直接跳过。
  - PingFang SC 是 macOS 独有。

  于是 Windows 上第一个**能用**的家族是微软雅黑——一个比例字体。xterm 按固定格宽摆字，
  而雅黑的拉丁字形比格子窄，屏幕上就是「每个字母之间都空一大格」。macOS 同样加载不到
  IBM Plex Mono，但 ui-monospace 在那边有效（落到 SF Mono），所以只有 Windows 显形。

  修法是在 CJK 之前补上各平台真正的等宽字体。顺序即优先级，别把 CJK 往前挪：
  Cascadia Mono / Consolas 是 Windows 自带（Consolas 从 Vista 起就有，是保底的那个），
  DejaVu Sans Mono 给 Linux。

  **不会影响格子测量的时序。** 那条规则见下面 waitForFont 的说明：出事的是 Web 字体
  晚到导致行高变化。这里加的都是系统本地字体，`fonts.load` 对它们立即落定，
  IBM Plex Mono 什么时候到也没有变。
*/
export const TERMINAL_FONT_FAMILY =
  '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", ' +
  '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace';
export const TERMINAL_FONT_SIZE = 13;

function waitForBox(el: HTMLElement, signal?: AbortSignal) {
  if (signal?.aborted || (el.clientWidth > 4 && el.clientHeight > 4)) return Promise.resolve();
  return new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { ro.disconnect(); clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const ro = new ResizeObserver(() => { if (el.clientWidth > 4 && el.clientHeight > 4) finish(); });
    ro.observe(el);
    timer = setTimeout(finish, 400);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * 字体没到就不要量。**字体和容器尺寸一样，是测量的输入。**
 *
 * 终端字体走 Google Fonts 且带 `display=swap`：先用回退字体渲染，字体到了再换掉，
 * 而换掉那一下格子高度就变了。在那之前量出来的行数偏大，等恢复的画面写进去之后
 * 才被改小——**xterm 缩行时会丢掉光标下面的行**，而序列化恢复恰好把光标放在 AI CLI
 * 的输入框里，于是输入框下半截被吃掉。更糟的是那次改小发给 PTY 的尺寸和它已有的相同，
 * 不产生 SIGWINCH，TUI 永远不知道要重画。
 * 见 issues/2026-09-10-restore-loses-rows-below-cursor.md。
 *
 * 超时不能省：字体 CDN 挂掉只该让字变丑，不该让终端起不来。字体晚到也有兜底——
 * 控制器订阅了 `loadingdone` 再 fit 一次，那一次 PTY 也会跟着改，所以能自愈。
 */
const FONT_WAIT_MS = 2000;
function waitForFont(signal?: AbortSignal) {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts || signal?.aborted) return Promise.resolve();
  const settled = Promise.all([
    fonts.load(`${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FAMILY}`).catch(() => undefined),
    fonts.ready.catch(() => undefined),
  ]).then(() => undefined);
  return Promise.race([settled, new Promise<void>(resolve => {
    const timer = setTimeout(resolve, FONT_WAIT_MS);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  })]);
}

/** 等到「量这个容器是可信的」：容器有尺寸，且字体已经定下来。 */
export async function waitForMeasurable(el: HTMLElement, signal?: AbortSignal) {
  await waitForBox(el, signal);
  await waitForFont(signal);
}

/** 字体晚到时再量一次。容器没变，ResizeObserver 不会响，只有这条路能发现。 */
export function observeFonts(callback: () => void) {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts) return () => {};
  fonts.addEventListener("loadingdone", callback);
  return () => { fonts.removeEventListener("loadingdone", callback); };
}
