import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ANSI_COLORS } from "./ansi-colors";

export type Theme = "dark" | "light";
export type TerminalAppearance = "follow" | Theme;

const STORAGE_KEY = "roost-theme";
const TERMINAL_KEY = "roost-terminal-appearance";
const CONTRAST_KEY = "roost-terminal-contrast";
const ACCEL_KEY = "roost-terminal-accel";
function stored(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function readTerminalAppearance(): TerminalAppearance {
  const value = stored(TERMINAL_KEY);
  return value === "dark" || value === "light" ? value : "follow";
}

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
  terminalAppearance: TerminalAppearance;
  setTerminalAppearance: (value: TerminalAppearance) => void;
  terminalContrast: boolean;
  /** 前台终端是否使用 WebGL 渲染器。见 `features/terminal/engine/accel.ts`。 */
  terminalAccel: boolean;
  setTerminalAccel: (value: boolean) => void;
  setTerminalContrast: (value: boolean) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** brightBlack -> bright-black：CSS 变量名用短横线。 */
const kebab = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

export function xtermThemeFromCss() {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: value("--terminal-bg") || value("--bg"),
    foreground: value("--terminal-fg") || value("--text"),
    cursor: value("--terminal-fg") || value("--accent"),
    cursorAccent: value("--terminal-bg") || value("--bg"),
    selectionBackground: value("--terminal-selection"),
    minimumContrastRatio: document.documentElement.dataset.terminalContrast === "off" ? 1 : 4.5,
    /*
      16 色照样从 CSS 变量来，和上面几项同一条路：主题切换只改变量，不用改这里。
      读不到就不传那一项，让 xterm 用它自己的默认值——总比传一个空串强。
    */
    ...Object.fromEntries(ANSI_COLORS.map(name => [name, value(`--terminal-${kebab(name)}`)]).filter(([, color]) => color)),
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [terminalAppearance, setTerminalAppearance] = useState<TerminalAppearance>(readTerminalAppearance);
  const [terminalContrast, setTerminalContrast] = useState(() => stored(CONTRAST_KEY) !== "off");
  /*
    默认**开**。这是个纯性能开关，关掉只是回到之前那条路；留着开关是为了在真机上能 A/B——
    渲染顺不顺只有眼睛看得出来，无头浏览器量不准（它连 WebGL 都没有）。
  */
  const [terminalAccel, setTerminalAccel] = useState(() => stored(ACCEL_KEY) !== "off");

  useLayoutEffect(() => {
    applyTheme(theme);
    document.documentElement.dataset.terminalTheme = terminalAppearance === "follow" ? theme : terminalAppearance;
    document.documentElement.dataset.terminalContrast = terminalContrast ? "on" : "off";
    document.documentElement.dataset.terminalAccel = terminalAccel ? "on" : "off";
    try {
      localStorage.setItem(STORAGE_KEY, theme);
      localStorage.setItem(TERMINAL_KEY, terminalAppearance);
      localStorage.setItem(CONTRAST_KEY, terminalContrast ? "on" : "off");
      localStorage.setItem(ACCEL_KEY, terminalAccel ? "on" : "off");
    } catch {
      // ignore
    }
  }, [theme, terminalAppearance, terminalContrast, terminalAccel]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setTheme(readStoredTheme());
      if (event.key === TERMINAL_KEY) setTerminalAppearance(readTerminalAppearance());
      if (event.key === CONTRAST_KEY) setTerminalContrast(stored(CONTRAST_KEY) !== "off");
      if (event.key === ACCEL_KEY) setTerminalAccel(stored(ACCEL_KEY) !== "off");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      terminalAppearance,
      setTerminalAppearance,
      terminalContrast,
      setTerminalContrast,
      terminalAccel,
      setTerminalAccel,
      toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark")),
    }),
    [theme, terminalAppearance, terminalContrast, terminalAccel],
  );

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
