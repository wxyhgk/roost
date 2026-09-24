import type { ServerSnapshot, ServerSummary } from '@roost/server-monitor/types';
import { emptyHistory, sampleHistory, type History } from './history';
import { startMonitorPolling } from './poll';

/*
  曲线的采样点长在 feed 上，不在组件上。

  它原来是 `ServerMonitorView` 里的一个 `useState`，而右面板整块挂着 `key={rightView}`
  （见 app/Shell.tsx）——换到「文件」再换回来，组件重建，攒了几分钟的曲线清零，从零开始
  每 5 秒一个点，而数据源这期间一直没断过。同一块面板还能同时存在两份（侧栏一份、浮动
  窗口一份），各自攒各自的，于是同一台机器画出两条不一样的曲线。

  判据是寿命：采样点的寿命该等于「在采」这件事的寿命，也就是 feed 的寿命，而且读它的人
  不止一个。所以它归 feed，组件只读。
*/
export type MonitorState = { summary: ServerSummary | null; detail: ServerSnapshot | null; failed: boolean; history: History };
type Mode = 'summary' | 'detail';
/** One browser feed serves both the always-visible footer and optional details. */
export function createMonitorFeed(read: { summary(signal: AbortSignal): Promise<ServerSummary>; detail(signal: AbortSignal): Promise<ServerSnapshot> }, events: {
  visible(): boolean;
  subscribe(wake: () => void, visibility: () => void): () => void;
}) {
  let state: MonitorState = { summary: null, detail: null, failed: false, history: emptyHistory() };
  const readers = new Map<() => void, Mode>();
  let mode: Mode | null = null, poll: ReturnType<typeof startMonitorPolling> | undefined, detach: (() => void) | undefined;
  const publish = (next: MonitorState) => { state = next; for (const notify of readers.keys()) notify(); };
  function reconcile() {
    const next = readers.size ? [...readers.values()].includes('detail') ? 'detail' : 'summary' : null;
    if (next === mode) return;
    poll?.dispose(); detach?.(); poll = undefined; detach = undefined; mode = next;
    if (!next) return;
    poll = startMonitorPolling<ServerSummary>({ read: read[next], visible: events.visible(), interval: next === 'detail' ? 5000 : 10000,
      /* 只有 detail 那一档带得动曲线：summary 里没有采样时刻，摘要模式下曲线原地留着不动。 */
      data: value => publish({ summary: value, detail: next === 'detail' ? value as ServerSnapshot : state.detail, failed: false,
        history: next === 'detail' ? sampleHistory(state.history, value as ServerSnapshot) : state.history }),
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
