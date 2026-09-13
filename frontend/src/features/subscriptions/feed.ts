import type { SubscriptionSnapshot } from '@roost/subscriptions';
export type UsageState = { snapshot: SubscriptionSnapshot | null; loading: boolean; failed: boolean };
export function createUsageFeed(read: (signal: AbortSignal, force: boolean) => Promise<SubscriptionSnapshot>, events: {
  visible(): boolean; subscribe(wake: () => void, visibility: () => void): () => void;
}, now = Date.now) {
  let state: UsageState = { snapshot: null, loading: false, failed: false };
  const listeners = new Set<() => void>();
  let generation = 0, failures = 0, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined, detach: (() => void) | undefined;
  const publish = (next: UsageState) => { state = next; listeners.forEach(fn => fn()); };
  function stop() { generation++; clearTimeout(timer); controller?.abort(); controller = undefined; }
  function schedule() {
    clearTimeout(timer); if (!listeners.size || !events.visible()) return;
    const retry = Date.parse(state.snapshot?.retryAt ?? '');
    const delay = failures ? Math.min(300000, 15000 * 2 ** Math.min(failures, 5)) : Math.max(60000, Number.isFinite(retry) ? retry - now() : 60000);
    timer = setTimeout(() => { void poll(); }, Math.min(300000, delay));
  }
  async function poll(force = false) {
    if (!listeners.size || !events.visible() || controller) return;
    clearTimeout(timer);
    const current = ++generation, abort = new AbortController(); controller = abort;
    const timeout = setTimeout(() => abort.abort(), 25000);
    publish({ ...state, loading: true });
    try {
      const snapshot = await read(abort.signal, force);
      if (generation !== current) return;
      failures = 0; publish({ snapshot, loading: false, failed: false });
    } catch {
      if (generation !== current) return;
      failures++; publish({ ...state, loading: false, failed: true });
    } finally {
      clearTimeout(timeout);
      if (generation === current) { controller = undefined; schedule(); }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(notify: () => void) {
      listeners.add(notify);
      if (listeners.size === 1) {
        detach = events.subscribe(() => { void poll(); }, () => { stop(); publish({ ...state, loading: false }); if (events.visible()) void poll(); });
        void poll();
      }
      return () => { listeners.delete(notify); if (!listeners.size) { stop(); detach?.(); detach = undefined; state = { ...state, loading: false }; } };
    },
    refresh() { return poll(true); },
    accept(snapshot: SubscriptionSnapshot) { stop(); failures = 0; publish({ snapshot, loading: false, failed: false }); schedule(); },
  };
}
