import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QuotaWindow } from '@roost/subscriptions';
import { cleanText, date, fingerprint, object, percent, readSmall, UsageError } from './common';
export async function cliPath(name: string, home: string, env: NodeJS.ProcessEnv) {
  const dirs = [...(env.PATH || '').split(delimiter), join(home, '.local/bin'), join(home, '.opencode/bin')].filter(Boolean);
  for (const dir of dirs) { const file = join(dir, name); try { await access(file, constants.X_OK); return file; } catch { /* Try the next configured directory. */ } }
  throw new UsageError('cli_missing', 'unsupported');
}
export async function codexScope(home: string, env: NodeJS.ProcessEnv) {
  const directory = env.CODEX_HOME || join(home, '.codex');
  try { const s = await stat(join(directory, 'auth.json')); return fingerprint([directory, s.ino, s.size, s.mtimeMs].join(':')); }
  catch { return fingerprint(directory); }
}
export function normalizeCodex(payload: unknown) {
  const body = object(payload), map = object(body.rateLimitsByLimitId);
  const buckets = Object.keys(map).length ? Object.entries(map).slice(0, 32) : [['codex', body.rateLimits]];
  const windows: QuotaWindow[] = [];
  for (const [key, raw] of buckets) {
    const bucket = object(raw), scope = cleanText(bucket.limitName) || cleanText(bucket.limitId) || cleanText(key) || 'Codex';
    for (const part of ['primary', 'secondary']) {
      const row = object(bucket[part]), used = percent(row.usedPercent);
      if (used == null && !date(row.resetsAt, true)) continue;
      const minutes = row.windowDurationMins;
      windows.push({ id: `${key}:${part}`, label: part, scope, usedPercent: used,
        durationSeconds: typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 && minutes < 1e7 ? minutes * 60 : null,
        resetsAt: date(row.resetsAt, true) });
    }
  }
  return { windows, primaryWindowId: windows.find(w => w.id === 'codex:primary')?.id ?? windows[0]?.id ?? null };
}
type ProbeOptions = { command: string; home: string; env: NodeJS.ProcessEnv; signal: AbortSignal; args?: string[]; version?: string };
export async function fetchCodex({ command, home, env, signal, args = ['app-server', '--listen', 'stdio://'], version }: ProbeOptions) {
  // This is our integration version, read from package metadata, not an
  // impersonated or hard-coded Codex CLI version.
  version ??= String(JSON.parse(await readSmall(fileURLToPath(new URL('../../package.json', import.meta.url)))).version);
  if (signal.aborted) throw new UsageError('timeout');
  return new Promise<{ windows: QuotaWindow[]; primaryWindowId: string | null; accountRef: string; accountLabel: string | null; plan: string | null }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: home, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let ended = false, buffer = '', bytes = 0, account: Record<string, any> | undefined, limits: Record<string, any> | undefined;
    const decoder = new TextDecoder();
    const terminate = () => {
      child.stdin.destroy(); child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 500); force.unref(); child.once('close', () => clearTimeout(force));
    };
    const finish = (error?: UsageError) => {
      if (ended) return; ended = true; clearTimeout(deadline); signal.removeEventListener('abort', abort); terminate();
      if (error) reject(error);
      else resolve({ ...normalizeCodex(limits), accountRef: fingerprint(JSON.stringify([account, limits?.accountId])), accountLabel: cleanText(account?.email), plan: cleanText(account?.planType) });
    };
    const abort = () => finish(new UsageError('timeout'));
    const deadline = setTimeout(abort, 18000); deadline.unref(); signal.addEventListener('abort', abort, { once: true });
    const send = (id: number | undefined, method: string, params?: object) => {
      if (!ended) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id == null ? {} : { id }), method, ...(params ? { params } : {}) }) + '\n');
    };
    child.on('error', error => finish(new UsageError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'cli_missing' : 'network', 'unsupported')));
    child.stdin.on('error', () => finish(new UsageError('network')));
    child.on('exit', () => { if (!ended) finish(new UsageError('network')); });
    child.stdout.on('data', (chunk: Buffer) => {
      if (ended) return;
      bytes += chunk.length; if (bytes > 1048576) { finish(new UsageError('invalid_response')); return; }
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while (!ended && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
        let message;
        try { message = object(JSON.parse(line)); } catch { finish(new UsageError('invalid_response')); break; }
        if (message.method === 'account/updated' && account) { finish(new UsageError('account_changed', 'auth-required')); break; }
        if (![1, 2, 3, 4].includes(message.id)) continue;
        if (message.error) {
          const code = message.error.code, text = String(message.error.message || '');
          finish(new UsageError(code === -32601 ? 'unsupported' : /429|rate.limit/i.test(text) ? 'rate_limited' : /auth|login|sign.in|401/i.test(text) ? 'login_required' : 'network', code === -32601 ? 'unsupported' : /auth|login|sign.in|401/i.test(text) ? 'auth-required' : 'unavailable'));
          break;
        }
        const result = object(message.result);
        if (message.id === 1) { send(undefined, 'initialized'); send(2, 'account/read', { refreshToken: false }); }
        else if (message.id === 2) {
          const candidate = object(result.account);
          if (!Object.keys(candidate).length) { finish(new UsageError('login_required', 'auth-required')); break; }
          if (!['chatgpt', 'chatgptAuthTokens'].includes(candidate.type)) { finish(new UsageError('no_subscription', 'unsupported')); break; }
          // Keep only identity fields; never forward arbitrary RPC account data.
          account = { type: candidate.type, email: cleanText(candidate.email), planType: cleanText(candidate.planType) };
          send(3, 'account/rateLimits/read');
        } else if (message.id === 3) { limits = result; send(4, 'account/read', { refreshToken: false }); }
        else {
          const current = object(result.account);
          if (!account || current.type !== account.type || cleanText(current.email) !== account.email || cleanText(current.planType) !== account.planType) finish(new UsageError('account_changed', 'auth-required'));
          else if (!limits || !('rateLimits' in limits || 'rateLimitsByLimitId' in limits)) finish(new UsageError('invalid_response'));
          else finish();
        }
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'roost_subscription_monitor', title: 'DIY subscription monitor', version } });
  });
}
