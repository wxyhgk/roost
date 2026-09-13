import * as api from '../../shared/api/bookmarks';
import type { BookmarkBoard } from '../../shared/api/bookmarks';

type Snapshot = BookmarkBoard & { loaded: boolean; loading: boolean; busy: boolean; error: string | null };
export function createBookmarkStore(client = api) {
  let snapshot: Snapshot = { cards: [], groups: [], loaded: false, loading: false, busy: false, error: null };
  const listeners = new Set<() => void>();
  let version = 0, pending: Promise<void> | null = null, mutations = 0;
  let tail = Promise.resolve();
  const publish = (patch: Partial<Snapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
  async function refresh() {
    const requestVersion = ++version;
    publish({ loading: true, error: null });
    try {
      const board = await client.fetchBookmarks();
      if (requestVersion === version) publish({ ...board, loaded: true });
    } catch (error) {
      if (requestVersion === version) publish({ error: String(error instanceof Error ? error.message : error) });
    } finally { if (requestVersion === version) publish({ loading: false }); }
  }
  function mutate(operation: () => Promise<unknown>) {
    mutations++; version++; publish({ busy: true, loading: false, error: null });
    const result = tail.then(async () => {
      try {
        await operation();
        const board = await client.fetchBookmarks();
        version++; publish({ ...board, loaded: true, loading: false });
      } catch (error) {
        publish({ error: String(error instanceof Error ? error.message : error) });
        throw error;
      }
    }).finally(() => { mutations--; publish({ busy: mutations > 0 }); });
    tail = result.catch(() => {});
    return result;
  }
  return {
    read: () => snapshot,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh,
    ensure() { if (!snapshot.loaded && !pending) pending = refresh().finally(() => { pending = null; }); return pending; },
    add: (input: Parameters<typeof api.addBookmark>[0]) => mutate(() => client.addBookmark(input)),
    update: (id: string, patch: Parameters<typeof api.patchBookmark>[1]) => mutate(() => client.patchBookmark(id, patch)),
    remove: (id: string) => mutate(() => client.removeBookmark(id)),
    addGroup: (id: string, name: string) => mutate(() => client.addBookmarkGroup(id, name)),
    updateGroup: (id: string, patch: Parameters<typeof api.patchBookmarkGroup>[1]) => mutate(() => client.patchBookmarkGroup(id, patch)),
    removeGroup: (id: string) => mutate(() => client.removeBookmarkGroup(id)),
  };
}
