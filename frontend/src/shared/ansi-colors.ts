/**
 * xterm 的 16 色键名。**以前一个都没传给 xterm**，于是浅色主题下亮色在白底上看不见，
 * 见 index.css 里那段。
 *
 * 放在共享层而不是 features/terminal：读 CSS 变量的 `xtermThemeFromCss` 就住在这儿，
 * 而共享层不许反过来依赖特性（check-boundaries 里那条）。
 */
export type AnsiColor =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
  | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite";
export const ANSI_COLORS: readonly AnsiColor[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];
