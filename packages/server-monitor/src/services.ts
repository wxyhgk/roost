import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { uptime } from 'node:os';
import type { ServiceInfo } from './types.ts';
const exec = promisify(execFile);
let lastIncompleteWarning = 0;
export function normalizeServices(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 24) throw new Error('Use up to 24 service names');
  const units = value.map(unit => {
    if (typeof unit !== 'string' || unit.length > 180 || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(unit)) throw new Error('Invalid service name');
    return unit.endsWith('.service') ? unit : unit + '.service';
  });
  return [...new Set(units)];
}
export async function hasSystemd(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try { await access('/run/systemd/system'); return true; } catch { return false; }
}
const numeric = (raw: string | undefined) => raw && /^\d+$/.test(raw) && Number(raw) < Number.MAX_SAFE_INTEGER ? Number(raw) : null;
export function parseServices(output: string, units: string[], hostUptime = uptime(), complete = false): ServiceInfo[] {
  const found = new Map<string, ServiceInfo>();
  for (const block of output.trim().split(/\n\s*\n/)) {
    const fields = Object.fromEntries(block.split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (!fields.Id) continue;
    const cpu = numeric(fields.CPUUsageNSec);
    const entered = numeric(fields.ActiveEnterTimestampMonotonic);
    const entry = { unit: fields.Id, load: fields.LoadState || 'unknown', active: fields.ActiveState || 'unknown', sub: fields.SubState || 'unknown', pid: numeric(fields.MainPID) || null, memory: numeric(fields.MemoryCurrent), cpuSeconds: cpu === null ? null : cpu / 1e9,
      description: (fields.Description ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240), enabled: fields.UnitFileState || 'unknown', result: fields.Result || 'unknown', restarts: numeric(fields.NRestarts), tasks: numeric(fields.TasksCurrent), uptime: fields.ActiveState === 'active' && entered != null && entered > 0 ? Math.max(0, hostUptime - entered / 1e6) : null };
    for (const name of [fields.Id, ...(fields.Names ?? '').split(' ')]) if (name) found.set(name, { ...entry, unit: name });
  }
  if (complete && units.some(unit => !found.has(unit))) throw new Error('Incomplete service snapshot');
  return units.map(unit => found.get(unit) ?? { unit, load: 'unknown', active: 'unknown', sub: 'unknown', pid: null, memory: null, cpuSeconds: null, description: '', enabled: 'unknown', result: 'unknown', restarts: null, tasks: null, uptime: null });
}
const runSystemctl = async (args: string[], timeout: number) => (await exec('systemctl', args, { timeout, maxBuffer: 256 * 1024, env: { ...process.env, LC_ALL: 'C', SYSTEMD_COLORS: '0' } })).stdout;
export async function readServices(units: string[], execute = runSystemctl): Promise<ServiceInfo[]> {
  if (!units.length) return [];
  const args = ['show', '--no-pager', '--property=Id,Names,LoadState,ActiveState,SubState,MainPID,MemoryCurrent,CPUUsageNSec,Description,UnitFileState,Result,NRestarts,TasksCurrent,ActiveEnterTimestampMonotonic', '--', ...normalizeServices(units)];
  try {
    let stdout = await execute(args, 2000);
    // Some hosts intermittently return a successful command with no properties.
    // Retry only that empty response, once; real command failures still surface.
    if (!stdout.trim()) stdout = await execute(args, 1000);
    try { return parseServices(stdout, units, uptime(), true); }
    catch (error) {
      if (Date.now() - lastIncompleteWarning > 60000) {
        lastIncompleteWarning = Date.now();
        console.warn('Incomplete systemd sample', JSON.stringify({ units, bytes: stdout.length, ids: stdout.match(/^Id=.*$/gm), keys: stdout.split('\n').map(line => line.slice(0, Math.max(0, line.indexOf('=')))).filter(Boolean).slice(0, 80) }));
      }
      throw error;
    }
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    if (e.code === 1 && e.stdout?.includes('Id=')) return parseServices(e.stdout, units, uptime(), true);
    throw error;
  }
}
