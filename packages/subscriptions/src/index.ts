export const providerIds = ['claude', 'chatgpt', 'opencode-go'] as const;
export type ProviderId = typeof providerIds[number];
export type SubscriptionState = 'ready' | 'stale' | 'auth-required' | 'unsupported' | 'unavailable' | 'waiting';
export type SubscriptionIssue = 'not_configured' | 'login_required' | 'no_subscription' | 'cli_missing' | 'collector_not_connected' | 'waiting_for_usage' | 'timeout' | 'network' | 'rate_limited' | 'invalid_response' | 'unsupported' | 'account_changed' | null;
export type QuotaWindow = {
  id: string; label: string; scope: string; usedPercent: number | null;
  durationSeconds: number | null; resetsAt: string | null;
};
export type SubscriptionSnapshot = {
  provider: ProviderId; runtimeId: string; accountRef: string | null; accountLabel: string | null;
  plan: string | null; renewalAt: string | null; state: SubscriptionState; issue: SubscriptionIssue;
  source: 'opencode-api' | 'codex-rpc' | 'claude-statusline';
  fetchedAt: string | null; observedAt: string | null; retryAt: string | null;
  windows: QuotaWindow[]; primaryWindowId: string | null;
  canConnect: boolean;
};
export function primaryWindow(snapshot: SubscriptionSnapshot | null): QuotaWindow | undefined {
  return snapshot?.windows.find(w => w.id === snapshot.primaryWindowId) ?? snapshot?.windows[0];
}
export function remainingPercent(window: QuotaWindow | undefined) {
  return window?.usedPercent == null ? null : Math.max(0, Math.min(100, 100 - window.usedPercent));
}
