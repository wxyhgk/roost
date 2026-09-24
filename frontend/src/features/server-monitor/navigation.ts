export type MonitorTab = 'overview' | 'cpu' | 'memory' | 'gpu' | 'network' | 'disks' | 'processes' | 'services' | 'ports';
export type MonitorTarget = { tab: MonitorTab; revision: number };
