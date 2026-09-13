import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";
import { promisify } from "node:util";
import { defaultShell } from './shell';
import { detectCli, detectConfiguredCli, type CliDefinition } from "@roost/cli-adapters";

const execFileAsync = promisify(execFile);

export function pidCwdLinux(pid: number) {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

type ProcRow = { pid: number; ppid: number; args: string };

export async function processTable(signal?: AbortSignal) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(defaultShell({ ...process.env, ROOST_SHELL: undefined }),
        ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress'],
        { timeout: 5000, windowsHide: true, signal, maxBuffer: 4 * 1024 * 1024 });
      return windowsProcessRows(stdout);
    }
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,args="], {
      timeout: 2000,
      signal,
    });
    const rows: ProcRow[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        args: match[3],
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export function windowsProcessRows(json: string): ProcRow[] {
  const values = JSON.parse(json.replace(/^\uFEFF/, ''));
  return (Array.isArray(values) ? values : [values]).flatMap(row =>
    Number.isInteger(row?.ProcessId) && Number.isInteger(row?.ParentProcessId) && typeof row?.CommandLine === 'string'
      ? [{ pid: row.ProcessId, ppid: row.ParentProcessId, args: row.CommandLine.replaceAll('\\', '/') }] : []);
}

export function cliForPid(rootPid: number, rows: ProcRow[], definitions?: readonly CliDefinition[]) {
  const recognize = (args:string) => definitions ? detectConfiguredCli(args, definitions) : detectCli(args);
  const root = rows.find(row => row.pid === rootPid);
  const rootCli = root && recognize(root.args);
  if (rootCli) return rootCli;
  const byParent = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row);
    byParent.set(row.ppid, list);
  }
  const stack = [rootPid];
  const visited = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    for (const child of byParent.get(pid) ?? []) {
      const found = recognize(child.args);
      if (found) return found;
      stack.push(child.pid);
    }
  }
  return null;
}

export async function batchCwds(pids: number[], signal?: AbortSignal) {
  const map = new Map<number, string>();
  if (pids.length === 0) return map;
  if (process.platform === 'win32') return map; // PowerShell OSC 7 supplies CWD changes.
  if (process.platform === "linux") {
    for (const pid of pids) {
      const cwd = pidCwdLinux(pid);
      if (cwd) map.set(pid, cwd);
    }
    return map;
  }
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")],
      { timeout: 2000, signal },
    );
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (line.startsWith("n") && pid) map.set(pid, line.slice(1));
    }
  } catch {
    // ignore
  }
  return map;
}
