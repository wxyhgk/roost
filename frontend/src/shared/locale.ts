// 语言状态的 React 入口：文案在 @roost/i18n，这里只负责让组件在切换时重渲染。
import { useSyncExternalStore } from "react";
import { getLocale, setLocale, subscribeLocale, type Locale } from "@roost/i18n";

export { setLocale };
export type { Locale };

/**
 * 订阅当前语言。渲染路径上调用它的组件在切换语言时会重渲染，
 * 包括被 memo 包住、props 不变的组件——t 是 Proxy，读得到新值但不会自己触发渲染。
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
