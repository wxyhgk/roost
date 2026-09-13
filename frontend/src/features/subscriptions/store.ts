import { useCallback, useSyncExternalStore } from 'react';
import { providerIds, type ProviderId, type SubscriptionSnapshot } from '@roost/subscriptions';
import { fetchSubscription } from '../../shared/api/subscriptions';
import { createUsageFeed } from './feed';
const feeds = Object.fromEntries(providerIds.map(provider => [provider, createUsageFeed((signal, force) => fetchSubscription(provider, signal, force), {
  visible: () => document.visibilityState !== 'hidden',
  subscribe(wake, visibility) {
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', visibility); };
  },
})])) as Record<ProviderId, ReturnType<typeof createUsageFeed>>;
export function useSubscription(provider: ProviderId) {
  return useSyncExternalStore(useCallback(fn => feeds[provider].subscribe(fn), [provider]), feeds[provider].getSnapshot);
}
export const refreshSubscription = (provider: ProviderId) => feeds[provider].refresh();
export const acceptSubscription = (snapshot: SubscriptionSnapshot) => feeds[snapshot.provider].accept(snapshot);
