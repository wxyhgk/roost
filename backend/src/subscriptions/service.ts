import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { ProviderId, SubscriptionSnapshot } from '@roost/subscriptions';
import { atomicPrivate, UsageError } from './common';
import { fetchGo, openCodeKey } from './opencode';
import { cliPath, codexScope, fetchCodex } from './codex';
import { claudeConnected, connectClaude, readClaude } from './claude';
export type PreparedSource = { identity: string; load(signal: AbortSignal): Promise<Partial<SubscriptionSnapshot>> };
type Options = { directory?: string; home?: string; env?: NodeJS.ProcessEnv; runtimeId?: string; now?: () => number; prepare?: (provider: ProviderId) => Promise<PreparedSource> };
type Entry = { identity: string; snapshot?: SubscriptionSnapshot; retryAt: number; failures: number; lastAttempt: number; flight?: Promise<SubscriptionSnapshot>; controller?: AbortController };
export function createSubscriptions({ directory, home = homedir(), env = process.env, runtimeId = hostname(), now = Date.now, prepare: customPrepare }: Options = {}) {
  const entries = new Map<ProviderId, Entry>(); let disposed = false, writing = Promise.resolve();
  const keyPath = directory ? join(directory, 'opencode-go-key.json') : undefined;
  const blank = (provider: ProviderId): SubscriptionSnapshot => ({ provider, runtimeId, accountRef: null, accountLabel: null, plan: null, renewalAt: null,
    state: 'unavailable', issue: null, source: provider === 'chatgpt' ? 'codex-rpc' : provider === 'claude' ? 'claude-statusline' : 'opencode-api',
    fetchedAt: null, observedAt: null, retryAt: null, windows: [], primaryWindowId: null, canConnect: provider === 'opencode-go' || provider === 'claude' });
  async function prepare(provider: ProviderId): Promise<PreparedSource> {
    if (customPrepare) return customPrepare(provider);
    if (provider === 'opencode-go') {
      const { key, identity } = await openCodeKey(home, env, keyPath);
      return { identity, load: async signal => { const result = await fetchGo(key, signal); return { ...result, accountRef: identity.slice(0, 24), primaryWindowId: [...result.windows].sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1))[0]?.id ?? null }; } };
    }
    if (provider === 'chatgpt') {
      const command = await cliPath('codex', home, env), identity = await codexScope(home, env);
      return { identity, load: signal => fetchCodex({ command, home, env, signal }) };
    }
    if (!directory || !await claudeConnected(directory, home, env)) throw new UsageError('collector_not_connected', 'waiting');
    // Identity follows the reporting CLI session. statusLine doesn't provide an
    // account ID; do not attribute it to a separately logged-in global account.
    const captured = await readClaude(directory);
    return { identity: captured.sessionRef, load: async () => ({ windows: captured.windows, primaryWindowId: captured.primaryWindowId, observedAt: captured.observedAt,
      canConnect: false, state: captured.windows.length ? now() - Date.parse(captured.observedAt || '') > 300000 ? 'stale' : 'ready' : 'waiting', issue: captured.windows.length ? null : 'waiting_for_usage' }) };
  }
  async function read(provider: ProviderId, force = false): Promise<SubscriptionSnapshot> {
    if (disposed) return { ...blank(provider), issue: 'network' };
    let source: PreparedSource;
    try { source = await prepare(provider); }
    catch (error) {
      const previous = entries.get(provider); previous?.controller?.abort(); entries.delete(provider);
      const e = error instanceof UsageError ? error : new UsageError('network');
      return { ...blank(provider), state: e.state, issue: e.issue, retryAt: new Date(now() + 60000).toISOString(), canConnect: provider === 'opencode-go' || e.issue === 'collector_not_connected' };
    }
    let entry = entries.get(provider);
    if (!entry || entry.identity !== source.identity) { entry?.controller?.abort(); entry = { identity: source.identity, retryAt: 0, failures: 0, lastAttempt: 0 }; entries.set(provider, entry); }
    if (entry.flight) return entry.flight;
    if (entry.snapshot && now() < entry.retryAt && (!force || entry.failures > 0 || now() - entry.lastAttempt < 5000)) return entry.snapshot;
    const current = entry, controller = new AbortController(); current.controller = controller; current.lastAttempt = now();
    const timeout = setTimeout(() => controller.abort(), 20000); timeout.unref();
    const flight = (async () => {
      let snapshot: SubscriptionSnapshot;
      try {
        const result = await source.load(controller.signal);
        if (controller.signal.aborted) throw new UsageError('timeout');
        const time = new Date(now()).toISOString();
        snapshot = { ...blank(provider), state: 'ready', fetchedAt: time, observedAt: time, ...result };
        if (!snapshot.windows.length && snapshot.state === 'ready') { snapshot.state = 'unsupported'; snapshot.issue = 'unsupported'; }
        current.failures = 0; current.retryAt = now() + (provider === 'claude' ? 15000 : 60000);
      } catch (error) {
        const e = controller.signal.aborted ? new UsageError('timeout') : error instanceof UsageError ? error : new UsageError('network');
        current.failures++;
        current.retryAt = now() + Math.max(e.retryMs ?? 0, Math.min(300000, 15000 * 2 ** Math.min(current.failures, 5)));
        const old = current.snapshot;
        const keep = ['network', 'timeout', 'rate_limited'].includes(e.issue) && old?.windows.length && old.observedAt && now() - Date.parse(old.observedAt) < 86400000;
        snapshot = { ...(keep ? old : blank(provider)), state: keep ? 'stale' : e.state, issue: e.issue };
      } finally { clearTimeout(timeout); }
      snapshot.retryAt = new Date(current.retryAt).toISOString();
      if (!disposed && entries.get(provider) === current) current.snapshot = snapshot;
      return snapshot;
    })();
    current.flight = flight;
    try { return await flight; } finally { if (current.flight === flight) { current.flight = undefined; current.controller = undefined; } }
  }
  const invalidate = (provider: ProviderId) => { entries.get(provider)?.controller?.abort(); entries.delete(provider); };
  return {
    read,
    async configure(provider: ProviderId, key?: string | null) {
      const operation = writing.catch(() => {}).then(async () => {
        if (!directory) throw new UsageError('unsupported', 'unsupported');
        if (provider === 'opencode-go') {
          if (key === null) await rm(keyPath!, { force: true });
          else {
            if (!key || key.length > 4096 || /\s/.test(key)) throw new UsageError('not_configured', 'auth-required');
            await atomicPrivate(keyPath!, JSON.stringify({ key }));
          }
        } else if (provider === 'claude') await connectClaude(directory, home, env);
        else throw new UsageError('unsupported', 'unsupported');
        invalidate(provider);
      });
      writing = operation; await operation;
    },
    dispose() { disposed = true; for (const entry of entries.values()) entry.controller?.abort(); entries.clear(); },
  };
}
export type Subscriptions = ReturnType<typeof createSubscriptions>;
