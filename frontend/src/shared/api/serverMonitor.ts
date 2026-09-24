import { request } from './request';
import type { ServerSnapshot, ServerSummary } from '@roost/server-monitor/types';
export type { ServerSnapshot } from '@roost/server-monitor/types';
export const fetchServerStatus = (signal: AbortSignal) => request<ServerSnapshot>('/api/server/status', { signal, cache: 'no-store' });
export const fetchServerSummary = (signal: AbortSignal) => request<ServerSummary>('/api/server/summary', { signal, cache: 'no-store' });
export const saveMonitoredServices = (services: string[], signal: AbortSignal) => request<{ services: string[] }>('/api/server/services', {
  method: 'PUT', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ services }),
});

/**
 * 整机在监听的端口 → 各是谁。
 *
 * **按需取，不要挂成轮询**：服务端要 fork 一次 lsof（本机约 28ms + 一次进程表扫描），
 * 点开面板时问一次绰绰有余；挂成每秒一次，进程多的机器上会变味。
 */
export type ListeningService = { address: string; port: number | null; pid: number; command: string | null };
export type PortsReport = { supported: boolean; services: ListeningService[] };
export const fetchListeningPorts = (signal: AbortSignal) =>
  request<PortsReport>('/api/server/ports', { signal, cache: 'no-store' });
