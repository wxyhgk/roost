import { useEffect, useState } from "react";
import { NARROW_LAYOUT_MAX, isNarrowLayout } from "./narrow";

/** 订阅「窄到一次只能放一段」这个判断。判据和阈值见 narrow.ts。 */
export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && isNarrowLayout(window.innerWidth));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    // 用 matchMedia 而不是 resize：只在**跨过**阈值时醒一次，拖窗口不会每一帧都重算。
    const query = window.matchMedia(`(max-width: ${NARROW_LAYOUT_MAX}px)`);
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return narrow;
}
