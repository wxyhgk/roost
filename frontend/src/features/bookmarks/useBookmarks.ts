import { useEffect, useSyncExternalStore } from 'react';
import { createBookmarkStore } from './store';

export const bookmarks = createBookmarkStore();
export function useBookmarks() {
  const state = useSyncExternalStore(bookmarks.subscribe, bookmarks.read, bookmarks.read);
  useEffect(() => { void bookmarks.ensure(); }, []);
  return state;
}
