import { readFile, readdir } from 'node:fs/promises';
import { cpus } from 'node:os';
import type { ProcessInfo, ProcessList } from './types.ts';
export function parseProcessStat(raw: string) {
  const open = raw.indexOf('('), close = raw.lastIndexOf(')');
  if (open < 1 || close <= open) throw new Error('invalid process stat');
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const ticks = Number(fields[11]) + Number(fields[12]);
  const started = fields[19];
  if (!Number.isFinite(ticks) || !started) throw new Error('invalid process counters');
  return { name: raw.slice(open + 1, close).replace(/[\x00-\x1f\x7f]/g, ''), state: fields[0], ticks, started, parentPid: Number(fields[1]), priority: Number(fields[15]), threads: Number(fields[17]) };
}
/** Read procfs with bounded concurrency instead of spawning one cat per PID. */
export function createLinuxProcesses() {
  let previous = new Map<string, { ticks: number; started: string }>(), lastTotal = 0;
  let users: Map<string, string> | undefined;
  return async (): Promise<ProcessList> => {
    if (!users) {
      users = new Map((await readFile('/etc/passwd', 'utf8').catch(() => '')).split('\n').map(line => { const p = line.split(':'); return [p[2], p[0]]; }));
    }
    const ids = (await readdir('/proc')).filter(id => /^\d+$/.test(id));
    const stat = await readFile('/proc/stat', 'utf8');
    const total = stat.split('\n')[0].trim().split(/\s+/).slice(1, 9).reduce((a, n) => a + Number(n), 0);
    const delta = total - lastTotal, next = new Map<string, { ticks: number; started: string }>();
    const rows: ProcessInfo[] = []; let offset = 0, running = 0;
    const cores = cpus().length;
    await Promise.all(Array.from({ length: Math.min(16, ids.length) }, async () => {
      while (offset < ids.length) {
        const id = ids[offset++];
        try {
          const [raw, status] = await Promise.all([readFile(`/proc/${id}/stat`, 'utf8'), readFile(`/proc/${id}/status`, 'utf8')]);
          const p = parseProcessStat(raw), old = previous.get(id);
          next.set(id, p);
          const uid = status.match(/^Uid:\s+(\d+)/m)?.[1] ?? '';
          if (p.state === 'R') running++;
          rows.push({ pid: Number(id), name: p.name, state: p.state, user: users!.get(uid) ?? uid, parentPid: p.parentPid, threads: p.threads, priority: p.priority, virtualMemory: Number(status.match(/^VmSize:\s+(\d+)/m)?.[1] ?? 0) * 1024,
            cpu: old?.started === p.started && delta > 0 && p.ticks >= old.ticks ? (p.ticks - old.ticks) / delta * cores * 100 : null,
            memory: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024 });
        } catch { /* A process may exit or become unreadable during the sample. */ }
      }
    }));
    previous = next; lastTotal = total;
    rows.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || b.memory - a.memory || a.pid - b.pid);
    return { total: ids.length, running, sleeping: rows.filter(p => p.state === 'S' || p.state === 'I').length, blocked: rows.filter(p => p.state === 'D').length, zombie: rows.filter(p => p.state === 'Z').length, list: rows.slice(0, 200), limited: rows.length > 200 };
  };
}
