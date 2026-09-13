import { useCallback, useSyncExternalStore } from 'react';
import { fetchServerStatus, fetchServerSummary } from '../../shared/api/serverMonitor';
import { createMonitorFeed } from './feed';
const feed = createMonitorFeed({ summary: fetchServerSummary, detail: fetchServerStatus }, {
  visible: () => document.visibilityState !== 'hidden',
  subscribe(wake, visibility) {
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', visibility); };
  },
});
export function useServerMonitor(mode: 'summary' | 'detail', active = true) {
  const subscribe = useCallback((notify: () => void) => active ? feed.subscribe(notify, mode) : () => {}, [mode, active]);
  return useSyncExternalStore(subscribe, feed.getSnapshot);
}
export const refreshServerMonitor = feed.refresh;
