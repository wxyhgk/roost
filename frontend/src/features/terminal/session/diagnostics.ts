export type TraceEvent = { at: number; event: string; value?: number };
// Deliberately excludes terminal text, input, cwd, snapshots and URLs.
export function createDiagnosticTrace(now = Date.now) {
  const events: TraceEvent[] = [];
  return {
    record(event: string, value?: number) { events.push({ at: now(), event, ...(value === undefined ? {} : { value }) }); if(events.length > 40) events.shift(); },
    read: () => events.map(e => ({ ...e })),
  };
}
/** 落后多久算「卡住了」。 */
const STALL_AFTER_MS = 10000;

/**
 * 终端是不是跟不上了。
 *
 * 判据是**已收到的序号和已写进终端的序号之间的差**持续存在了多久。
 *
 * 原来看的是 `pendingWrites`——那是个死判据：所有写都排在同一条 FIFO 队列上依次执行，
 * 所以它永远只能是 0 或 1，而每一批最多 256KB、几毫秒就写完。于是**洪流期间终端落后再多，
 * 这里也永远不会报**。真正会涨的是 `received - applied`。
 */
export function stalledParser(
  behind: number,
  behindSince: number | null,
  now: number,
  active: boolean,
  visible: boolean,
) {
  return active && visible && behind > 0 && behindSince !== null && now - behindSince >= STALL_AFTER_MS;
}
