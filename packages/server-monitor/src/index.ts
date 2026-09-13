import { createLinuxProcesses } from './linux-processes.ts';
import * as os from 'node:os';
import si from 'systeminformation';
import { createProbe } from './probe.ts';
import { normalizeFor, serviceManager } from './manager.ts';
import type { CpuInfo, DiskInfo, GpuInfo, MemoryInfo, NetworkInfo, ProcessList, ServerSnapshot, ServiceInfo, ServerSummary, SystemInfo, ThermalInfo, DiskActivity, ConnectionInfo } from './types.ts';
export { createServerMonitorProcess } from './collector-client.ts';
/**
 * 校验并规范化用户配置的服务名，**按这台机器实际用的管理器**。
 *
 * 后端保存配置时用的就是它。原来直接导出 systemd 那版，在 macOS 上会把
 * `com.roost.terminal` 补成 `.service` 结尾——存下去是个 launchd 永远找不到的名字。
 */
export function normalizeServiceNames(value: unknown): string[] {
  return normalizeFor(serviceManager(), value);
}
export type { ServerSnapshot } from './types.ts';
const valid = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const pct = (n: unknown) => { const v = valid(n); return v === null ? null : Math.min(100, v); };
const megabytes = (n: unknown) => { const v = valid(n); return v === null ? null : v * 1024 * 1024; };
const text = (s: unknown, cap = 160) => typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, '').slice(0, cap) : '';
export function connectionSummary(rows: si.Systeminformation.NetworkConnectionsData[]): ConnectionInfo {
  const state = (s: string) => s.toUpperCase().replace(/-/g, '_');
  const listening = rows.filter(r => state(r.state) === 'LISTEN' || (r.protocol.startsWith('udp') && ['UNCONN', 'UNKNOWN', ''].includes(state(r.state))));
  listening.sort((a, b) => Number(a.localPort) - Number(b.localPort));
  return { total: rows.length, established: rows.filter(r => state(r.state) === 'ESTABLISHED').length,
    timeWait: rows.filter(r => state(r.state) === 'TIME_WAIT').length, listening: listening.length,
    udp: rows.filter(r => r.protocol.startsWith('udp')).length, limited: listening.length > 100,
    listeners: listening.slice(0, 100).map(r => ({ protocol: text(r.protocol, 10), address: text(r.localAddress), port: text(r.localPort, 10), pid: valid(r.pid), process: text(r.process) })) };
}
export function processList(data: si.Systeminformation.ProcessesData): ProcessList {
  // Deliberately project fields: raw process records contain command arguments,
  // which can include tokens. Neither HTTP nor logs get those raw records.
  const rows = data.list.map(p => ({ pid: p.pid, name: text(p.name), user: text(p.user, 60), cpu: valid(p.cpu), parentPid: valid(p.parentPid), threads: null, priority: Number.isFinite(p.priority) ? p.priority : null, virtualMemory: valid(p.memVsz) === null ? null : p.memVsz * 1024, memory: (valid(p.memRss) ?? 0) * 1024, state: text(p.state, 30) }));
  rows.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || b.memory - a.memory || a.pid - b.pid);
  return { total: data.all, running: data.running, sleeping: data.sleeping ?? 0, blocked: data.blocked ?? 0, zombie: rows.filter(p => p.state === 'zombie' || p.state === 'Z').length, list: rows.slice(0, 200), limited: rows.length > 200 };
}
export function createServerMonitor(initialServices?: string[]) {
  const manager = serviceManager();
  let units = normalizeFor(manager, initialServices ?? manager?.defaults ?? []), warmed = false;
  let cpuDescription: ReturnType<typeof si.cpu> | undefined;
  const supported = manager ? manager.available() : Promise.resolve(false);
  const system = createProbe<SystemInfo>(async () => {
    const [o, s] = await Promise.all([si.osInfo(), si.system()]);
    return { distro: text(o.distro), release: text(o.release), manufacturer: text(s.manufacturer), model: text(s.model), virtual: s.virtual, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }, 300000);
  const thermal = createProbe<ThermalInfo>(async () => {
    const [temperature, speed] = await Promise.all([si.cpuTemperature(), si.cpuCurrentSpeed()]);
    return { temperature: temperature.main > 0 ? valid(temperature.main) : null, maxTemperature: temperature.max > 0 ? valid(temperature.max) : null, speed: speed.avg > 0 ? valid(speed.avg) : null, coreSpeeds: speed.cores.map(n => n > 0 ? valid(n) : null) };
  }, 15000);
  const cpu = createProbe<CpuInfo>(async () => {
    cpuDescription ??= si.cpu().catch(error => { cpuDescription = undefined; throw error; });
    const [description, current] = await Promise.all([cpuDescription, si.currentLoad()]);
    const ready = warmed; warmed = true;
    const logicalCores = os.cpus().length || description.cores;
    const usage = ready ? pct(current.currentLoad) : null;
    return { model: text(description.manufacturer + ' ' + description.brand), physicalCores: valid(description.physicalCores), logicalCores, availableCores: os.availableParallelism(), usage, busyCores: usage === null ? null : usage * logicalCores / 100, user: ready ? pct(current.currentLoadUser) : null, system: ready ? pct(current.currentLoadSystem) : null, idle: ready ? pct(current.currentLoadIdle) : null, steal: ready && process.platform === 'linux' ? pct(current.currentLoadSteal) : null,
      speedBase: description.speed > 0 ? valid(description.speed) : null, speedMax: description.speedMax > 0 ? valid(description.speedMax) : null, sockets: valid(description.processors), cache: { l1d: valid(description.cache.l1d), l1i: valid(description.cache.l1i), l2: valid(description.cache.l2), l3: valid(description.cache.l3) }, cores: current.cpus.map(c => ready ? pct(c.load) : null), loadAverage: os.loadavg() };
  }, 4000);
  const memory = createProbe<MemoryInfo>(async () => {
    const m = await si.mem();
    const linux = process.platform === 'linux';
    return { total: m.total, used: Math.max(0, m.total - m.available), available: m.available, swapTotal: m.swaptotal, swapUsed: m.swapused, free: valid(m.free), active: valid(m.active), buffers: linux ? valid(m.buffers) : null, cached: linux ? valid(m.cached) : null, slab: linux ? valid(m.slab) : null, dirty: linux ? valid(m.dirty) : null, writeback: linux ? valid(m.writeback) : null };
  }, 4000);
  const network = createProbe<NetworkInfo[]>(async () => {
    const [interfaces, stats] = await Promise.all([si.networkInterfaces(), si.networkStats('*')]);
    if (!Array.isArray(interfaces)) throw new Error('interfaces unavailable');
    return interfaces.filter(i => !i.internal).slice(0, 64).map(i => {
      const s = stats.find(s => s.iface === i.iface);
      return { name: text(i.iface), ipv4: text(i.ip4), ipv6: text(i.ip6), state: text(i.operstate), default: i.default, virtual: i.virtual, mac: text(i.mac), speed: valid(i.speed), mtu: valid(i.mtu), type: text(i.type), duplex: text(i.duplex), rxErrors: valid(s?.rx_errors), txErrors: valid(s?.tx_errors), rxDropped: valid(s?.rx_dropped), txDropped: valid(s?.tx_dropped), rxBytes: valid(s?.rx_bytes), txBytes: valid(s?.tx_bytes), rxPerSecond: valid(s?.rx_sec), txPerSecond: valid(s?.tx_sec) };
    });
  }, 4000);
  const disks = createProbe<DiskInfo[]>(async () => (await si.fsSize()).filter(d => d.size > 0).slice(0, 64).map(d => ({ device: text(d.fs), mount: text(d.mount, 300), type: text(d.type), size: d.size, used: d.used, available: d.available, usage: pct(d.use) ?? 0, writable: d.rw ?? null })), 30000);
  const gpu = createProbe<GpuInfo[]>(async () => (await si.graphics()).controllers.slice(0, 16).map(g => ({ model: text(g.model), vendor: text(g.vendor), usage: pct(g.utilizationGpu), memoryTotal: megabytes(g.memoryTotal ?? g.vram), memoryUsed: megabytes(g.memoryUsed), temperature: valid(g.temperatureGpu), sharedMemory: g.vramDynamic, cores: valid(g.cores), bus: text(g.bus), driver: text(g.driverVersion), power: valid(g.powerDraw), powerLimit: valid(g.powerLimit), clockCore: valid(g.clockCore), clockMemory: valid(g.clockMemory), fan: pct(g.fanSpeed) })), 15000);
  const diskActivity = createProbe<DiskActivity>(async () => {
    const [f, d] = await Promise.all([si.fsStats(), si.disksIO()]);
    return { readBytes: valid(f.rx), writeBytes: valid(f.wx), readRate: valid(f.rx_sec), writeRate: valid(f.wx_sec), readIops: valid(d.rIO_sec), writeIops: valid(d.wIO_sec) };
  }, 4000);
  const connections = createProbe<ConnectionInfo>(() => si.networkConnections().then(connectionSummary), 15000);
  const linuxProcesses = createLinuxProcesses();
  const processes = createProbe(() => process.platform === 'linux' ? linuxProcesses() : si.processes().then(processList), 10000);
  const services = createProbe(async () => { if (!manager || !await supported) throw new Error('service manager unavailable'); return manager.read(units); }, 4000);
  return {
    async summary(): Promise<ServerSummary> {
      const [c, m, n] = await Promise.all([cpu.get(), memory.get(), network.get()]);
      return { timestamp: Date.now(), host: { hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(), uptime: os.uptime() }, cpu: c, memory: m, network: n };
    },
    async snapshot(): Promise<ServerSnapshot> {
      const [c, m, n, d, g, p, s, supportedNow, hostSystem, temperatures, activity, sockets] = await Promise.all([cpu.get(), memory.get(), network.get(), disks.get(), gpu.get(), processes.get(), services.get(), supported, system.get(), thermal.get(), diskActivity.get(), connections.get()]);
      return { timestamp: Date.now(), host: { hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(), uptime: os.uptime() }, cpu: c, memory: m, network: n, disks: d, gpu: g, processes: p, services: s, serviceManager: manager && supportedNow ? manager.kind : 'unsupported', configuredServices: [...units], system: hostSystem, thermal: temperatures, diskActivity: activity, connections: sockets };
    },
    configure(next: string[]) { units = normalizeFor(manager, next); services.invalidate(); },
    dispose() { for (const probe of [cpu, memory, network, disks, gpu, processes, services, system, thermal, diskActivity, connections]) probe.dispose(); },
  };
}
export type ServerMonitor = ReturnType<typeof createServerMonitor>;
