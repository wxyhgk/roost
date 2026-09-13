// 界面文案的组合入口。每个域一个文件，便于并行编辑而不互相覆盖：
// 中文在 src/<domain>.ts，英文在 src/en/<domain>.ts。
// 形状约定（嵌套、带参数写成函数、普通模块导出而非 hook）见 workspace.ts 顶部。

import { statusBar as zhStatusBar } from "./statusBar";
import { statusBar as enStatusBar } from "./en/statusBar";
import { serverMonitor as zhServerMonitor } from "./serverMonitor";
import { serverMonitor as enServerMonitor } from "./en/serverMonitor";
import { workspace as zhWorkspace } from "./workspace";
import { files as zhFiles } from "./files";
import { notes as zhNotes } from "./notes";
import { library as zhLibrary } from "./library";
import { terminal as zhTerminal } from "./terminal";
import { settings as zhSettings } from "./settings";
import { misc as zhMisc } from "./misc";
import { bookmarks as zhBookmarks } from "./bookmarks";
import { errorText as zhErrorText } from "./errors";

import { workspace as enWorkspace } from "./en/workspace";
import { files as enFiles } from "./en/files";
import { notes as enNotes } from "./en/notes";
import { library as enLibrary } from "./en/library";
import { terminal as enTerminal } from "./en/terminal";
import { settings as enSettings } from "./en/settings";
import { misc as enMisc } from "./en/misc";
import { bookmarks as enBookmarks } from "./en/bookmarks";
import { errorText as enErrorText } from "./en/errors";

export type Locale = "zh" | "en";

/** 把 as const 的字面量类型放宽成 string，两份语言包才能共用同一份形状。 */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : T extends object
        ? { readonly [K in keyof T]: Widen<T[K]> }
        : T;

const zh = {
  ...zhWorkspace,
  files: zhFiles,
  notes: zhNotes,
  library: zhLibrary,
  terminal: zhTerminal,
  settings: zhSettings,
  misc: zhMisc,
  bookmarks: zhBookmarks,
  serverMonitor: zhServerMonitor,
  statusBar: zhStatusBar,
};

/** 文案树的形状。英文包用这个类型约束，漏键或形状不符会在编译期报错。 */
export type Messages = Widen<typeof zh>;

const en: Messages = {
  ...enWorkspace,
  files: enFiles,
  notes: enNotes,
  library: enLibrary,
  terminal: enTerminal,
  settings: enSettings,
  misc: enMisc,
  bookmarks: enBookmarks,
  serverMonitor: enServerMonitor,
  statusBar: enStatusBar,
};

const catalogs: Record<Locale, Messages> = { zh, en };

const STORAGE_KEY = "roost-locale";
const listeners = new Set<() => void>();

// 浏览器全局在 Node 测试里不存在；不为一句语言检测把 DOM lib 拉进这个包。
const globals = globalThis as {
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  navigator?: { language?: string };
  window?: unknown;
};

function detect(): Locale {
  try {
    const saved = globals.localStorage?.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* 隐私模式下读取也可能抛错：按默认语言兜底。 */
  }
  // 只有真浏览器才有「用户语言」这回事；Node 里 navigator.language 是运行环境默认值，
  // 拿它决定界面语言会让测试随机器变化。浏览器里非英文系统仍回落到中文。
  const language = globals.window ? globals.navigator?.language : undefined;
  return language && /^en\b/i.test(language) ? "en" : "zh";
}

let locale: Locale = detect();

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  if (next === locale) return;
  locale = next;
  try {
    globals.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    /* 存不下不影响本次切换，只是刷新后回到检测结果。 */
  }
  listeners.forEach((fn) => fn());
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 当前语言的全部文案。切换语言后再读即新值，不要缓存在模块顶层。 */
export function getMessages(): Messages {
  return catalogs[locale];
}

/**
 * 当前语言的文案。用 Proxy 而不是 `export let t`：
 * 调用点形状 `t.session.kill` 不变，切语言后下次读取就是新值，
 * store、library/client 这类非 React 模块也能直接用。
 * 界面上的即时更新由 frontend 的 useLocale() 触发重渲染，见 frontend/src/shared/locale.ts。
 */
export const t: Messages = new Proxy({} as Messages, {
  get: (_target, key) => catalogs[locale][key as keyof Messages],
  has: (_target, key) => key in catalogs[locale],
  ownKeys: () => Reflect.ownKeys(catalogs[locale]),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

export function errorText(code: string | null, status: number, serverMessage?: string | null): string {
  return (locale === "en" ? enErrorText : zhErrorText)(code, status, serverMessage);
}
