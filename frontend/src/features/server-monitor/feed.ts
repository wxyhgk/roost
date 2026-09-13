import type { ServerSnapshot, ServerSummary } from '@roost/server-monitor/types';
import { startMonitorPolling } from './poll';

export type MonitorState = { summary: ServerSummary | null; detail: ServerSnapshot | null; failed: boolean };
type Mode = 'summary' | 'detail';
/** One browser feed serves both the always-visible footer and optional details. */
export function createMonitorFeed(read: { summary(signal: AbortSignal): Promise<ServerSummary>; detail(signal: AbortSignal): Promise<ServerSnapshot> }, events: {
  visible(): boolean;
  subscribe(wake: () => void, visibility: () => void): () => void;
}) {
  let state: MonitorState = { summary: null, detail: null, failed: false };
  const readers = new Map<() => void, Mode>();
  let mode: Mode | null = null, poll: ReturnType<typeof startMonitorPolling> | undefined, detach: (() => void) | undefined;
  const publish = (next: MonitorState) => { state = next; for (const notify of readers.keys()) notify(); };
  function reconcile() {
    const next = readers.size ? [...readers.values()].includes('detail') ? 'detail' : 'summary' : null;
    if (next === mode) return;
    poll?.dispose(); detach?.(); poll = undefined; detach = undefined; mode = next;
    if (!next) return;
    poll = startMonitorPolling<ServerSummary>({ read: read[next], visible: events.visible(), interval: next === 'detail' ? 5000 : 10000,
      data: value => publish({ summary: value, detail: next === 'detail' ? value as ServerSnapshot : state.detail, failed: false }),
      error: () => publish({ ...state, failed: true }),
    });
    detach = events.subscribe(() => poll?.refresh(), () => poll?.visible(events.visible()));
  }
  return {
    getSnapshot: () => state,
    subscribe(notify: () => void, mode: Mode) {
      readers.set(notify, mode); reconcile();
      return () => { readers.delete(notify); reconcile(); };
    },
    refresh() { poll?.refresh(); },
  };
}
