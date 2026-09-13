import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServiceInfo } from './types.ts';

const exec = promisify(execFile);

/**
 * macOS 这边的服务状态，对应 services.ts 的 systemd 那套。
 *
 * 两边给的东西不一样多，`ServiceInfo` 是照 systemd 的形状定的，所以这里有几格
 * **如实留空**而不是编一个值：
 *
 *   - `description`：launchd 没有这个概念，plist 里也没有对应字段。
 *   - `tasks`：systemd 数的是 cgroup 里的进程数，macOS 没有 cgroup。真要数得去遍历
 *     子进程树，那是另一回事，而且和「服务健康」关系不大。
 *
 * 其余几格 launchd 是有的，只是名字不同：`runs` 是启动次数（减一才是重启次数），
 * `last exit code` 对应 systemd 的 Result。内存、CPU 时间和运行时长 launchctl 不给，
 * 从 pid 用一次 ps 批量取回来。
 */
export function hasLaunchd(): boolean {
  return process.platform === 'darwin';
}

/**
 * launchd 的标签，不是 systemd 的单元名——**不要加 `.service` 后缀**。
 *
 * 和 normalizeServices 分开写就是为了这一点：那边给 `nginx` 补成 `nginx.service`，
 * 在这边会把 `com.roost.terminal` 变成一个不存在的标签。
 */
export function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 24) throw new Error('Use up to 24 service names');
  const labels = value.map(label => {
    if (typeof label !== 'string' || label.length > 180 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(label)) throw new Error('Invalid service name');
    return label;
  });
  return [...new Set(labels)];
}

/**
 * `launchctl print` 的输出是一棵缩进树，**只取最外层那一级**。
 *
 * 里面嵌着 `resource coalition = { ... state = active ... }` 这样的块，也有自己的
 * `state`；按缩进过滤之前，一个天真的 `state = ` 匹配会拿到那个而不是服务本身的。
 */
export function parseLaunchdPrint(output: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = /^\t([a-z][a-z ]*) = (.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

const ELAPSED = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/;
/** ps 的 etime：`MM:SS`、`HH:MM:SS`、`DD-HH:MM:SS`。 */
export function parseElapsed(text: string): number | null {
  const m = ELAPSED.exec(text.trim());
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** ps 的 time（累计 CPU）：`MM:SS.ss` 或 `HH:MM:SS.ss`。 */
export function parseCpuTime(text: string): number | null {
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  const [, hours, minutes, seconds] = m;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export type ProcessSample = { memory: number | null; cpuSeconds: number | null; uptime: number | null };

/** `ps -o pid=,rss=,etime=,time=` 的输出。rss 单位是 KiB。 */
export function parsePs(output: string): Map<number, ProcessSample> {
  const samples = new Map<number, ProcessSample>();
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [pid, rss, elapsed, cpu] = parts;
    if (!/^\d+$/.test(pid)) continue;
    samples.set(Number(pid), {
      memory: /^\d+$/.test(rss) ? Number(rss) * 1024 : null,
      uptime: parseElapsed(elapsed),
      cpuSeconds: parseCpuTime(cpu),
    });
  }
  return samples;
}

const ABSENT: ServiceInfo = { unit: '', load: 'not-found', active: 'unknown', sub: 'unknown', pid: null, memory: null, cpuSeconds: null, description: '', enabled: 'unknown', result: 'unknown', restarts: null, tasks: null, uptime: null };

/**
 * 一个服务的 print 输出 + 它的 ps 采样 → ServiceInfo。
 *
 * `runs` 是**启动次数**：第一次起来就是 1，所以重启次数要减一。照抄的话每个刚装好
 * 的服务都会显示「重启过 1 次」。
 */
export function toServiceInfo(label: string, fields: Record<string, string> | null, sample: ProcessSample | undefined, disabled: boolean): ServiceInfo {
  if (!fields) return { ...ABSENT, unit: label, enabled: disabled ? 'disabled' : 'unknown' };
  const state = fields.state ?? 'unknown';
  const pid = /^\d+$/.test(fields.pid ?? '') ? Number(fields.pid) : null;
  const runs = /^\d+$/.test(fields.runs ?? '') ? Number(fields.runs) : null;
  const exit = fields['last exit code'] ?? '';
  return {
    unit: label,
    load: 'loaded',
    active: state === 'running' ? 'active' : state === 'waiting' ? 'activating' : 'inactive',
    sub: state,
    pid,
    memory: sample?.memory ?? null,
    cpuSeconds: sample?.cpuSeconds ?? null,
    // launchd 没有服务描述这一说，不编。
    description: '',
    enabled: disabled ? 'disabled' : 'enabled',
    result: exit === '' ? 'unknown' : /^\(never exited\)$|^0$/.test(exit) ? 'success' : 'exit-code',
    restarts: runs === null ? null : Math.max(0, runs - 1),
    // macOS 没有 cgroup，数不出「这个服务下有几个任务」。
    tasks: null,
    uptime: sample?.uptime ?? null,
  };
}

/** `launchctl print-disabled` 列出被显式停用的标签，一次调用覆盖全部。 */
export function parseDisabled(output: string): Set<string> {
  const disabled = new Set<string>();
  for (const line of output.split('\n')) {
    const m = /^\s*"([^"]+)"\s*=>\s*(?:disabled|true)\s*$/.exec(line);
    if (m) disabled.add(m[1]);
  }
  return disabled;
}

type Runner = (file: string, args: string[], timeout: number) => Promise<string>;
const runCommand: Runner = async (file, args, timeout) =>
  (await exec(file, args, { timeout, maxBuffer: 256 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout;

export async function readLaunchdServices(labels: string[], execute: Runner = runCommand): Promise<ServiceInfo[]> {
  const wanted = normalizeLabels(labels);
  if (!wanted.length) return [];
  const domain = `gui/${process.getuid?.() ?? 0}`;
  /*
    停用清单一次取回，不要每个服务问一次：它是整个 domain 的一张表。
    取不到就当作「都没停用」——这一格显示错了无伤大雅，为它让整块状态失败不值得。
  */
  const disabled = await execute('launchctl', ['print-disabled', domain], 2000).then(parseDisabled, () => new Set<string>());
  const printed = await Promise.all(wanted.map(label =>
    // 没装载的服务 print 会以非零退出，这是正常情况，不是错误。
    execute('launchctl', ['print', `${domain}/${label}`], 2000).then(parseLaunchdPrint, () => null)));
  const pids = printed.map(fields => (fields && /^\d+$/.test(fields.pid ?? '') ? fields.pid : null)).filter((pid): pid is string => pid !== null);
  const samples = pids.length
    ? await execute('ps', ['-o', 'pid=,rss=,etime=,time=', '-p', pids.join(',')], 2000).then(parsePs, () => new Map<number, ProcessSample>())
    : new Map<number, ProcessSample>();
  return wanted.map((label, i) => toServiceInfo(label, printed[i], samples.get(Number(printed[i]?.pid)), disabled.has(label)));
}
