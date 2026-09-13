import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { library } from "./runtime";
import { LibraryQuery } from "./query";
import type { Kind } from "./api";
function useChannel(key: string) {
  const source = useMemo(() => ({ subscribe: (fn: () => void) => library.subscribeChannel(key, fn), snapshot: () => library.channelSnapshot(key) }), [key]);
  useSyncExternalStore(source.subscribe, source.snapshot);
}
export function useLibraryDraft(kind: Kind, id: string | null) {
  useChannel(`${kind}:${id ?? ""}`);
  return id ? library.get(kind, id) : undefined;
}
export function usePendingLibrary(kind: Kind) { useChannel(`pending:${kind}`); return library.unsaved(kind); }
export function useLibraryRecovery() { useChannel("recovery"); return library; }
export function useLibraryList(kind: Kind, query: string, enabled = true) {
  const [q, setQ] = useState(query.slice(0, 200));
  useEffect(() => { const timer = setTimeout(() => setQ(query.slice(0, 200)), 200); return () => clearTimeout(timer); }, [query]);
  const controller = useMemo(() => new LibraryQuery(library, kind, q), [kind, q]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => { if (enabled) return controller.start(); }, [controller, enabled]);
  return { ...state, more: controller.more, refresh: controller.refresh };
}
