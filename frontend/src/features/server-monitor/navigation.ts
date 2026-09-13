export type MonitorTab = 'overview' | 'cpu' | 'memory' | 'gpu' | 'network' | 'disks' | 'processes' | 'services';
export type MonitorTarget = { tab: MonitorTab; revision: number };
