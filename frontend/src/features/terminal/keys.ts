/*
  手机键栏的键位表和转义序列。**纯数据 + 纯函数，一行 DOM 都不碰。**

  为什么单独一个文件：这些字节序列错一个字符就是「按了没反应」或者「打出一堆乱码」，
  而这个仓库的前端测试没有 jsdom——逻辑留在 .tsx 里就一条都测不了。所以键位表、修饰键
  状态机、编码函数全部落在这儿，`view/KeyBar.tsx` 只负责按下去和画出来。

  序列的出处不是记忆，是 xterm.js 自己的 `common/input/Keyboard.ts`（`evaluateKeyboardEvent`，
  可以在 node_modules 的 sourcemap 里读到原文）。理由很实在：这些字节最终要被同一个
  xterm 实例的对端程序读，而桌面上用**真键盘**按出来的就是那份表的输出。键栏如果自己另
  编一套，同一个键在手机和电脑上就会送出不同的东西，对端行为不一致时根本无从查起。
*/

const ESC = "\x1b";

/** 一次按下要送出去的修饰状态。shift 只由 ⇧⇥ 这类固定组合键内部产生，栏上没有 Shift 键。 */
export type Mods = { ctrl: boolean; alt: boolean; shift: boolean };

export const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

/**
 * xterm 风格的修饰参数：shift=1、alt=2、ctrl=4 求或，再 +1。
 * 没有修饰时是 1，而 1 的形式恰好是「不带参数」那一支，所以调用点只要判 `=== 1`。
 */
export function modifierParam(mods: Mods): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

export type BarKeyId =
  | "esc" | "shiftTab" | "minus" | "home" | "up" | "end" | "pageUp"
  | "tab" | "ctrl" | "alt" | "left" | "down" | "right" | "pageDown";

export type BarKey = {
  id: BarKeyId;
  /** 键面。**不进 i18n**：这些是终端键的通用符号，Termux / iSH / Blink 在任何语言下印的都是同一串。 */
  face: string;
  /** 修饰键不送字节，只改下一次按键的解释。 */
  modifier?: "ctrl" | "alt";
  /** 按住不放要连发吗。只给移动光标的键——Esc / Tab 连发几乎只会是误触的后果。 */
  repeats?: boolean;
};

/*
  两行键位直接抄 Termux 的默认值（`TermuxPropertyConstants.java:329`），**只换一个键**：
  第一行第二个的 `/` 换成 ⇧⇥。

  为什么照抄：这是十年打磨出来的排布，两行十四键里每一个都是在小屏上被反复验证过的取舍，
  我们没有比它更好的依据。为什么换掉 `/`：Claude Code 靠 Shift+Tab 切权限模式
  （default → auto-accept → plan），而**软键盘根本发不出这个组合**；`/` 软键盘上有。
  Termius 在 2025-08 专门为此加了一个独立键，同一个坑别人已经踩过了。
*/
export const KEY_ROWS: readonly (readonly BarKey[])[] = [
  [
    { id: "esc", face: "Esc" },
    { id: "shiftTab", face: "⇧⇥" },
    { id: "minus", face: "-" },
    { id: "home", face: "Home" },
    { id: "up", face: "↑", repeats: true },
    { id: "end", face: "End" },
    { id: "pageUp", face: "PgUp", repeats: true },
  ],
  [
    { id: "tab", face: "Tab" },
    { id: "ctrl", face: "Ctrl", modifier: "ctrl" },
    { id: "alt", face: "Alt", modifier: "alt" },
    { id: "left", face: "←", repeats: true },
    { id: "down", face: "↓", repeats: true },
    { id: "right", face: "→", repeats: true },
    { id: "pageDown", face: "PgDn", repeats: true },
  ],
];

/** 长按多久算「锁定」而不是「点了一下」。400ms 是 Termux 的阈值。 */
export const HOLD_MS = 400;
/** 按住方向键多久开始连发、之后每隔多久一次。300 / 120 抄的是 ttyd 的 PR #1504。 */
export const REPEAT_DELAY_MS = 300;
export const REPEAT_INTERVAL_MS = 120;

/*
  修饰键的三态。**Termux、iSH、Blink 各自独立写出了同一个模型**，没有一家有分歧：
  点一下 = 只对下一个键生效（once），长按 = 锁定到再按一次为止（locked）。

  为什么不是简单的开关：手机上一次 Ctrl+C 之后几乎总是要回到普通打字，开关式的 Ctrl
  会让下一个字母继续变成控制字符，而屏幕上没有任何东西提醒你它还开着。反过来，连按
  Ctrl+W 删好几个词时又不想每次都去点一下 Ctrl。两种需求都真实，所以是三态。
*/
export type Latch = "off" | "once" | "locked";

export type Latches = { ctrl: Latch; alt: Latch };

export const LATCHES_OFF: Latches = { ctrl: "off", alt: "off" };

export function latchActive(latch: Latch): boolean {
  return latch !== "off";
}

/** 轻点：灭的点亮成一次性；已经亮着的（不管哪种）一律灭掉——「再点一下取消」是唯一说得通的语义。 */
export function tapLatch(latch: Latch): Latch {
  return latch === "off" ? "once" : "off";
}

/** 长按：锁上；已经锁着的长按解锁。从 once 长按也是锁上——那是「我改主意了，要连按」。 */
export function holdLatch(latch: Latch): Latch {
  return latch === "locked" ? "off" : "locked";
}

export function latchMods(latches: Latches): Mods {
  return { ctrl: latchActive(latches.ctrl), alt: latchActive(latches.alt), shift: false };
}

/** 送出一段字节之后：一次性的落下，锁定的留着。 */
export function consumeLatches(latches: Latches): Latches {
  const drop = (latch: Latch): Latch => (latch === "once" ? "off" : latch);
  return { ctrl: drop(latches.ctrl), alt: drop(latches.alt) };
}

/*
  Ctrl + 某个字符的控制码。

  字母那一段是 `charCodeAt - 64`（大写 A=65 → 0x01），不列在表里。表里是**剩下那些**
  ——它们看着像特例，其实是同一条规则的延续：ASCII 的控制码就是把字符的第 6 位清零，
  `@`(0x40)→NUL、`[`(0x5b)→ESC、`\`→FS、`]`→GS、`^`→RS、`_`→US。

  数字键那几行是键盘的历史包袱而不是 ASCII 规律：美式键盘上 Ctrl+Shift+2 打出的是 `@`，
  于是终端约定 Ctrl+2 = NUL、Ctrl+3..7 = 0x1b..0x1f、Ctrl+8 = DEL。xterm.js 是按 keyCode
  51..56 实现的，也就是主键区的 2–8。软键盘送来的是字符不是 keyCode，所以这里按字符写。
  `?` 同理：Ctrl+? = DEL(0x7f) 是老终端的老约定，留着不亏。
*/
const CTRL_CHARS: Readonly<Record<string, string>> = {
  " ": "\x00", "@": "\x00", "2": "\x00",
  "[": "\x1b", "3": "\x1b",
  "\\": "\x1c", "4": "\x1c",
  "]": "\x1d", "5": "\x1d",
  "^": "\x1e", "6": "\x1e",
  "_": "\x1f", "7": "\x1f",
  "?": "\x7f", "8": "\x7f",
};

/**
 * 一个普通字符加上键栏按着的修饰键，该送什么。
 *
 * 返回 `null` = **什么都别送**。这不是偷懒：Ctrl 对大多数字符没有定义（Ctrl+中文、
 * Ctrl+逗号），猜一个字节塞进正在跑的程序，代价远大于「这一下没反应」。
 */
export function encodeChar(ch: string, mods: Mods): string | null {
  // 按码点算长度：emoji 和多数 CJK 之外的字符在 UTF-16 里是两个单元，`ch.length` 会说 2。
  if ([...ch].length !== 1) return null;
  let out = ch;
  if (mods.ctrl) {
    const ctrl = /^[a-zA-Z]$/.test(ch)
      ? String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64)
      : CTRL_CHARS[ch];
    if (!ctrl) return null;
    out = ctrl;
  }
  // Alt 是「前面加一个 ESC」（meta-sends-escape），而且加在控制码**外面**：
  // Alt+Ctrl+W 是 ESC 0x17，不是 Ctrl 作用在 ESC 上。
  if (mods.alt) out = ESC + out;
  return out;
}

/**
 * 键栏上某一个键该送什么。修饰键本身返回 `null`（它不送字节）。
 *
 * 光标键这里一律送**普通模式**的 `CSI A` 而不是应用模式的 `SS3 A`：应用光标模式
 * （DECCKM，`?1h`）是对端开的，我们这一侧没有跟踪它——`engine/dec.ts` 跟踪的模式集合里
 * 没有 1。而实践上这条偏差是安全的：readline 默认把 `\e[A` 和 `\eOA` 都绑到上一条历史，
 * Ink（Claude Code、Codex 的 TUI 底座）的按键解析两种都认，vim 也是。反过来如果猜着送
 * SS3，在没开应用模式的普通 shell 里就是实打实的错。
 */
export function encodeBarKey(id: BarKeyId, mods: Mods): string | null {
  const param = modifierParam(mods);
  // 带修饰时光标键要写成 `CSI 1 ; <param> <末字符>`，不带修饰时省掉整个参数段。
  const cursor = (final: string) => (param === 1 ? `${ESC}[${final}` : `${ESC}[1;${param}${final}`);
  // PgUp/PgDn 是 `~` 家族，参数接在自己的编号后面：`CSI 5 ; <param> ~`。
  const tilde = (code: string) => (param === 1 ? `${ESC}[${code}~` : `${ESC}[${code};${param}~`);
  switch (id) {
    case "up": return cursor("A");
    case "down": return cursor("B");
    case "right": return cursor("C");
    case "left": return cursor("D");
    // Home/End 走的是同一族的 H/F。**不是** `CSI 1~` / `CSI 4~`（那是 VT220/Linux 控制台那一套），
    // xterm 和 xterm.js 都发 H/F，对端按 terminfo 认的也是 xterm 的那份。
    case "home": return cursor("H");
    case "end": return cursor("F");
    case "pageUp": return tilde("5");
    case "pageDown": return tilde("6");
    // Alt+Esc = ESC ESC。Ctrl 对 Esc 没有定义，xterm.js 直接忽略，这里照做。
    case "esc": return mods.alt ? ESC + ESC : ESC;
    case "tab": return mods.shift ? `${ESC}[Z` : "\t";
    // CSI Z（backtab / terminfo 的 kcbt）。它是**一个独立键**，不是「Tab 加一个 Shift 修饰参数」
    // ——写成 `CSI 1;2 I` 那种形式对端认不出来。
    case "shiftTab": return `${ESC}[Z`;
    case "minus": return encodeChar("-", mods);
    case "ctrl": case "alt": return null;
  }
}
