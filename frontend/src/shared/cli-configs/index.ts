import { useEffect, useSyncExternalStore } from 'react';
import { createCliConfigStore } from './store';
export type { CliConfig, CliConfigInput, CliConfigPatch, CliRule } from './store';

const store = createCliConfigStore();
let consumers = 0;
const onFocus = () => { void store.refresh(); };

export function useCliConfigs() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (consumers++ === 0) window.addEventListener('focus', onFocus);
    void store.ensureLoaded();
    return () => {
      if (--consumers === 0) window.removeEventListener('focus', onFocus);
    };
  }, []);
  return { ...snapshot, refresh: store.refresh, create: store.create, update: store.update,
    remove: store.remove, reset: store.reset, uploadIcon: store.uploadIcon };
}

export function useCliConfig(id: string | null | undefined) {
  return useCliConfigs().configs.find(config => config.id === id);
}
