export const providers = [
  { id: 'claude', name: 'Claude', logo: '/logos/claude-mark.svg' },
  { id: 'chatgpt', name: 'ChatGPT', logo: '/logos/codex-mark.svg' },
  { id: 'opencode-go', name: 'OpenCode Go', logo: '/logos/opencode-mark.svg' },
] as const;
import type { ProviderId } from '@roost/subscriptions';
export type { ProviderId } from '@roost/subscriptions';
const key = 'roost-subscription-provider';
export function readProvider(storage: () => Pick<Storage, 'getItem'> = () => localStorage): ProviderId {
  try { const value = storage().getItem(key); return providers.find(p => p.id === value)?.id ?? 'claude'; }
  catch { return 'claude'; }
}
export function saveProvider(value: ProviderId, storage: () => Pick<Storage, 'setItem'> = () => localStorage) {
  try { storage().setItem(key, value); } catch { /* A preference must not interrupt a live terminal. */ }
}
