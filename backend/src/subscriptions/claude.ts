import { readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { QuotaWindow } from '@roost/subscriptions';
import { atomicPrivate, date, object, percent, readSmall, UsageError } from './common';
import { cliPath } from './codex';
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
export function claudeSettings(home: string, env: NodeJS.ProcessEnv) { return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'); }
async function settingsText(path: string) { try { return await readSmall(path, 1048576); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}'; throw error; } }
export async function claudeConnected(directory: string, home: string, env: NodeJS.ProcessEnv) {
  try {
    const settings = JSON.parse(await settingsText(claudeSettings(home, env)));
    const metadata = JSON.parse(await readSmall(join(directory, 'claude-statusline-config.json')));
    return settings.statusLine?.type === 'command' && settings.statusLine.command === metadata.installedCommand;
  } catch { return false; }
}
export async function connectClaude(directory: string, home: string, env: NodeJS.ProcessEnv, checkCli = true) {
  if (checkCli) await cliPath('claude', home, env);
  const requested = claudeSettings(home, env);
  const path = await realpath(requested).catch(error => { if (error.code === 'ENOENT') return requested; throw error; });
  const originalText = await settingsText(path);
  let settings: Record<string, any>;
  try { settings = JSON.parse(originalText); if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(); } catch { throw new UsageError('invalid_response'); }
  if (settings.statusLine && settings.statusLine.type !== 'command') throw new UsageError('unsupported', 'unsupported');
  let original = settings.statusLine ?? null;
  try { const previous = JSON.parse(await readSmall(join(directory, 'claude-statusline-config.json'))); if (settings.statusLine?.command === previous.installedCommand) original = previous.original; } catch { /* First connection. */ }
  const helper = join(directory, 'claude-statusline.mjs'), command = `${quote(process.execPath)} ${quote(helper)}`;
  if (typeof original?.command === 'string' && original.command.includes(helper)) throw new UsageError('unsupported', 'unsupported');
  await atomicPrivate(helper, await readSmall(fileURLToPath(new URL('./claude-statusline.mjs', import.meta.url))));
  await atomicPrivate(join(directory, 'claude-settings-before-' + Date.now() + '.json'), originalText);
  await atomicPrivate(join(directory, 'claude-statusline-config.json'), JSON.stringify({ original, installedCommand: command }));
  // Do not overwrite a settings edit that arrived while preparing the helper.
  if (await settingsText(path) !== originalText) throw new UsageError('account_changed');
  settings.statusLine = { ...object(settings.statusLine), type: 'command', command };
  await atomicPrivate(path, JSON.stringify(settings, null, 2) + '\n');
}
export async function readClaude(directory: string) {
  let files: string[];
  try { files = (await readdir(join(directory, 'claude-captures'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 128); }
  catch { throw new UsageError('waiting_for_usage', 'waiting'); }
  const samples = await Promise.all(files.map(async name => {
    try { return object(JSON.parse(await readSmall(join(directory, 'claude-captures', name), 8192))); } catch { return {}; }
  }));
  const sample = samples.filter(s => typeof s.sessionRef === 'string' && /^[a-f0-9]{64}$/.test(s.sessionRef) && date(s.receivedAt)).sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0];
  if (!sample) throw new UsageError('waiting_for_usage', 'waiting');
  const rates = object(sample.rates), windows: QuotaWindow[] = [];
  for (const id of ['five_hour', 'seven_day', 'spend_limit']) {
    const row = object(rates[id]), used = percent(row.used_percentage);
    if (used == null) continue;
    windows.push({ id, label: id, scope: 'Claude Code · ' + sample.sessionRef.slice(0, 8), usedPercent: used,
      durationSeconds: id === 'five_hour' ? 18000 : id === 'seven_day' ? 604800 : null, resetsAt: date(row.resets_at, true) });
  }
  return { windows, observedAt: date(sample.observedAt), sessionRef: sample.sessionRef, primaryWindowId: windows[0]?.id ?? null };
}
