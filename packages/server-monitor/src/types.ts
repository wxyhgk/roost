export type Metric<T> = { data: T | null; sampledAt: number | null; status: 'ok' | 'stale' | 'unavailable' };
export type ServerSummary = Pick<ServerSnapshot, 'timestamp' | 'host' | 'cpu' | 'memory' | 'network'>;
export type CpuInfo = {
  model: string; logicalCores: number; physicalCores: number | null; availableCores: number;
  usage: number | null; busyCores: number | null; cores: (number | null)[]; loadAverage: number[];
  user: number | null; system: number | null; idle: number | null; steal: number | null;
  speedBase: number | null; speedMax: number | null; sockets: number | null;
  cache: { l1d: number | null; l1i: number | null; l2: number | null; l3: number | null };
};
export type MemoryInfo = { total: number; used: number; available: number; swapTotal: number; swapUsed: number; free: number | null; active: number | null; buffers: number | null; cached: number | null; slab: number | null; dirty: number | null; writeback: number | null };
export type SystemInfo = { distro: string; release: string; manufacturer: string; model: string; virtual: boolean; timezone: string };
export type ThermalInfo = { temperature: number | null; maxTemperature: number | null; speed: number | null; coreSpeeds: (number | null)[] };
export type NetworkInfo = {
  name: string; ipv4: string; ipv6: string; state: string; default: boolean; virtual: boolean;
  rxBytes: number | null; txBytes: number | null; rxPerSecond: number | null; txPerSecond: number | null;
  mac: string; speed: number | null; mtu: number | null; type: string; duplex: string;
  rxErrors: number | null; txErrors: number | null; rxDropped: number | null; txDropped: number | null;
};
export type DiskInfo = { device: string; mount: string; type: string; size: number; used: number; available: number; usage: number; writable: boolean | null };
export type DiskActivity = { readBytes: number | null; writeBytes: number | null; readRate: number | null; writeRate: number | null; readIops: number | null; writeIops: number | null };
export type ConnectionInfo = { total: number; established: number; timeWait: number; listening: number; udp: number; listeners: { protocol: string; address: string; port: string; pid: number | null; process: string }[]; limited: boolean };
export type GpuInfo = { model: string; vendor: string; usage: number | null; memoryTotal: number | null; memoryUsed: number | null; temperature: number | null; sharedMemory: boolean; cores: number | null; bus: string; driver: string; power: number | null; powerLimit: number | null; clockCore: number | null; clockMemory: number | null; fan: number | null };
export type ProcessInfo = { pid: number; name: string; user: string; cpu: number | null; memory: number; state: string; parentPid: number | null; threads: number | null; priority: number | null; virtualMemory: number | null };
export type ProcessList = { total: number; running: number; sleeping: number; blocked: number; zombie: number; list: ProcessInfo[]; limited: boolean };
export type ServiceInfo = { unit: string; load: string; active: string; sub: string; pid: number | null; memory: number | null; cpuSeconds: number | null; description: string; enabled: string; result: string; restarts: number | null; tasks: number | null; uptime: number | null };
export type ServerSnapshot = {
  timestamp: number;
  host: { hostname: string; platform: string; release: string; arch: string; uptime: number };
  cpu: Metric<CpuInfo>; memory: Metric<MemoryInfo>; network: Metric<NetworkInfo[]>;
  disks: Metric<DiskInfo[]>; gpu: Metric<GpuInfo[]>; processes: Metric<ProcessList>; services: Metric<ServiceInfo[]>;
  system: Metric<SystemInfo>; thermal: Metric<ThermalInfo>; diskActivity: Metric<DiskActivity>; connections: Metric<ConnectionInfo>;
  serviceManager: 'systemd' | 'unsupported'; configuredServices: string[];
};
