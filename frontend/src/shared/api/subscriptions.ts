import type { ProviderId, SubscriptionSnapshot } from '@roost/subscriptions';
import { request } from './request';
async function read(provider: ProviderId, action: string, init: RequestInit) {
  const snapshot = await request<SubscriptionSnapshot>(`/api/subscriptions/${provider}${action}`, { ...init, cache: 'no-store' });
  if (snapshot.provider !== provider || !Array.isArray(snapshot.windows)) throw new Error('Invalid subscription response');
  return snapshot;
}
export const fetchSubscription = (provider: ProviderId, signal: AbortSignal, force = false) => read(provider, force ? '/refresh' : '', { signal, method: force ? 'POST' : 'GET' });
export const connectClaudeSubscription = (signal: AbortSignal) => read('claude', '/connect', { method: 'POST', signal });
export const saveGoKey = (key: string | null, signal: AbortSignal) => read('opencode-go', '/key', { method: key === null ? 'DELETE' : 'PUT', signal,
  ...(key === null ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }) });
