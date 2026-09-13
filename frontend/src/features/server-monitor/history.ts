import type { ServerSnapshot } from '@roost/server-monitor/types';
export type Point = { at: number; value: number | null };
export type Series = { source: string; points: Point[] };
export type History = Record<'cpu' | 'memory' | 'rx' | 'tx' | 'read' | 'write', Series>;
export const emptyHistory = (): History => {
  const series = (): Series => ({ source: '', points: [] });
  return { cpu: series(), memory: series(), rx: series(), tx: series(), read: series(), write: series() };
};
export function appendSeries(series: Series, source: string, at: number | null, value: number | null): Series {
  const points = series.source === source ? series.points : [];
  if (at == null || (points.length && at <= points[points.length - 1].at)) return series.source === source ? series : { source, points };
  return { source, points: [...points.filter(p => p.at >= at - 300000).slice(-59), { at, value: value != null && Number.isFinite(value) && value >= 0 ? value : null }] };
}
export function sampleHistory(history: History, s: ServerSnapshot): History {
  const nic = s.network.data?.find(n => n.default), memory = s.memory.data;
  const host = s.host.hostname;
  return {
    cpu: appendSeries(history.cpu, host, s.cpu.sampledAt, s.cpu.data?.usage ?? null),
    memory: appendSeries(history.memory, host, s.memory.sampledAt, memory && memory.total > 0 ? memory.used / memory.total * 100 : null),
    rx: appendSeries(history.rx, host + ':' + nic?.name, s.network.sampledAt, nic?.rxPerSecond ?? null),
    tx: appendSeries(history.tx, host + ':' + nic?.name, s.network.sampledAt, nic?.txPerSecond ?? null),
    read: appendSeries(history.read, host, s.diskActivity?.sampledAt ?? null, s.diskActivity?.data?.readRate ?? null),
    write: appendSeries(history.write, host, s.diskActivity?.sampledAt ?? null, s.diskActivity?.data?.writeRate ?? null),
  };
}
/** Separate missing samples and long pauses instead of inventing continuity. */
export function segments(points: Point[], ceiling?: number): string[] {
  const max = ceiling ?? Math.max(1, ...points.map(p => p.value ?? 0));
  const start = points[0]?.at ?? 0, span = Math.max(5000, (points.at(-1)?.at ?? start) - start);
  const result: string[] = []; let path: string[] = [], previous = 0;
  for (const p of points) {
    if (p.value == null || (previous && p.at - previous > 15000)) { if (path.length > 1) result.push(path.join(' ')); path = []; }
    if (p.value != null) path.push(`${(p.at - start) / span * 100},${28 - Math.min(1, p.value / max) * 26}`);
    previous = p.at;
  }
  if (path.length > 1) result.push(path.join(' '));
  return result;
}
