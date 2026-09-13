import type { Metric } from './types.ts';
/** A slow collector occupies one slot even after its deadline. Other metrics
 * still respond; multiple tabs cannot create a subprocess storm. */
export function createProbe<T>(read: () => Promise<T>, interval: number, timeout = 3000, now = Date.now) {
  let value: T | null = null, sampledAt: number | null = null, attemptedAt = -Infinity;
  let running: Promise<void> | null = null, failed = false, disposed = false, generation = 0;
  const state = (): Metric<T> => ({ data: value, sampledAt, status: value === null ? 'unavailable' : failed || sampledAt! + interval * 2 < now() ? 'stale' : 'ok' });
  return {
    async get(): Promise<Metric<T>> {
      if (disposed || (!running && now() - Math.max(attemptedAt, sampledAt ?? -Infinity) < interval)) return state();
      if (!running) {
        attemptedAt = now();
        const current = generation;
        running = Promise.resolve().then(read).then(data => {
          if (!disposed && current === generation) { value = data; sampledAt = now(); failed = false; }
        }).catch(() => { if (current === generation) failed = true; }).finally(() => { running = null; });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([running, new Promise<void>(resolve => { timer = setTimeout(() => { failed = true; resolve(); }, timeout); })]);
      clearTimeout(timer);
      return state();
    },
    invalidate() { generation++; value = null; sampledAt = null; attemptedAt = -Infinity; },
    dispose() { disposed = true; generation++; },
  };
}
