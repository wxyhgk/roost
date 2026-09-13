// Synchronous state ownership keeps actions current even before React renders.
export function createObservable<S, A>(initial: S, reduce: (state: S, action: A) => S) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    dispatch: (action: A) => {
      const next = reduce(state, action);
      if (Object.is(next, state)) return;
      state = next; listeners.forEach(fn => fn());
    },
  };
}
export function selectFields<T extends object, K extends keyof T>(read: () => T, keys: readonly K[]) {
  let previous: Pick<T, K> | undefined;
  return () => {
    const value = read();
    if (previous && keys.every(key => Object.is(previous![key], value[key]))) return previous;
    previous = Object.fromEntries(keys.map(key => [key, value[key]])) as Pick<T, K>;
    return previous;
  };
}
