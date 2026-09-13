import { useCallback, useSyncExternalStore } from 'react';
import { sessionStatus } from './runtime';
export function useSessionActivity(id: string) {
  const subscribe = useCallback((fn: () => void) => sessionStatus.subscribe(id, fn), [id]);
  const read = useCallback(() => sessionStatus.read(id), [id]);
  return useSyncExternalStore(subscribe, read, read);
}
