import { LibraryClient } from "./client";
import { request } from "./api";
import { adoptRoostKeys, discardLegacyLibrary } from "./legacy-cleanup";

let storage: Storage | undefined;
try { storage = typeof window === "undefined" ? undefined : window.localStorage;  } catch { /* Report on first draft backup. */ }
/*
  收拾旧键要在**构造 LibraryClient 之前**：它的构造函数当场就会读 last-id，
  放到 startLibraryRuntime 里就晚了，那一次会读到已经被搬走的旧键（读不到）。
  顺序也不能反，理由见 adoptRoostKeys 的说明。
*/
if (storage) {
  try { discardLegacyLibrary(storage); adoptRoostKeys(storage); } catch { /* Persistence reports unavailable storage. */ }
}
export const library = new LibraryClient(request, storage);
export function startLibraryRuntime() {
  if (typeof window === "undefined") return () => {};
  const events = new AbortController();
  const options = { signal: events.signal };
  window.addEventListener("focus", () => library.refreshAll(), options);
  window.addEventListener("online", () => library.refreshAll(), options);
  window.addEventListener("pagehide", () => library.persistAll(), options);
  document.addEventListener("visibilitychange", () => { if (document.hidden) library.persistAll(); else library.refreshAll(); }, options);
  window.addEventListener("storage", e => { if (e.storageArea === storage && (e.key === null || e.key.startsWith("roost-library-draft:"))) library.refreshBackups(); }, options);
  return () => {
    library.persistAll(); events.abort(); library.dispose();
  };
}
