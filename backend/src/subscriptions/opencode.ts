import { join } from 'node:path';
import type { QuotaWindow } from '@roost/subscriptions';
import { cleanText, date, fingerprint, object, percent, readSmall, UsageError } from './common';
export async function openCodeKey(home: string, env: NodeJS.ProcessEnv, savedPath?: string) {
  let key: unknown;
  if (savedPath) {
    try { key = object(JSON.parse(await readSmall(savedPath, 8192))).key; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new UsageError('not_configured', 'auth-required'); }
  }
  key ||= env.OPENCODE_GO_API_KEY || env.OPENCODE_API_KEY;
  if (!key) {
    try {
      const auth = object(JSON.parse(await readSmall(join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'auth.json'))));
      const go = object(auth['opencode-go']);
      if (go.type === 'api') key = go.key;
    } catch { /* Missing CLI authentication is a normal unconfigured state. */ }
  }
  if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /\s/.test(key.trim())) throw new UsageError('not_configured', 'auth-required');
  return { key: key.trim(), identity: fingerprint(key.trim()) };
}
export function normalizeGo(payload: unknown): QuotaWindow[] {
  const usage = object(object(payload).usage);
  const windows = (['rolling', 'weekly', 'monthly'] as const).flatMap(id => {
    const row = object(usage[id]), used = percent(row.percent);
    if (used == null && !date(row.resetsAt)) return [];
    return [{ id, label: id, scope: 'OpenCode Go', usedPercent: used, durationSeconds: id === 'rolling' ? 18000 : id === 'weekly' ? 604800 : null, resetsAt: date(row.resetsAt) }];
  });
  if (!windows.some(w => w.usedPercent != null)) throw new UsageError('invalid_response');
  return windows;
}
export async function fetchGo(key: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher('https://opencode.ai/zen/go/v1/usage', { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) throw new UsageError('login_required', 'auth-required');
    if (response.status === 403) throw new UsageError('no_subscription', 'unsupported');
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const ms = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 60000;
      throw new UsageError('rate_limited', 'unavailable', Number.isFinite(ms) ? Math.max(60000, Math.min(86400000, ms)) : 60000);
    }
    throw new UsageError('network');
  }
  const reader = response.body?.getReader(); if (!reader) throw new UsageError('invalid_response');
  let length = 0, text = ''; const decoder = new TextDecoder();
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 65536) throw new UsageError('invalid_response'); text += decoder.decode(value, { stream: true }); }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  try { const body = object(JSON.parse(text)); return { windows: normalizeGo(body), accountLabel: cleanText(body.accountLabel), plan: cleanText(body.plan) ?? 'OpenCode Go' }; }
  catch (error) { if (error instanceof UsageError) throw error; throw new UsageError('invalid_response'); }
}
