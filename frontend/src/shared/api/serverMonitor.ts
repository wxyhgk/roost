import { request } from './request';
import type { ServerSnapshot, ServerSummary } from '@roost/server-monitor/types';
export type { ServerSnapshot } from '@roost/server-monitor/types';
export const fetchServerStatus = (signal: AbortSignal) => request<ServerSnapshot>('/api/server/status', { signal, cache: 'no-store' });
export const fetchServerSummary = (signal: AbortSignal) => request<ServerSummary>('/api/server/summary', { signal, cache: 'no-store' });
export const saveMonitoredServices = (services: string[], signal: AbortSignal) => request<{ services: string[] }>('/api/server/services', {
  method: 'PUT', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ services }),
});
