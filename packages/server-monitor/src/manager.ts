import { hasSystemd, normalizeServices, readServices } from './services.ts';
import { hasLaunchd, normalizeLabels, readLaunchdServices } from './launchd.ts';
import type { ServiceInfo } from './types.ts';

/**
 * 两套服务管理器，同一份 ServiceInfo：Linux 的 systemd，macOS 的 launchd。
 *
 * 名字规则**不通用**，这是必须分派而不能只在读取处分叉的原因：systemd 要把 `nginx`
 * 补成 `nginx.service`，而 launchd 的标签是 `com.roost.terminal`，补后缀会变成一个
 * 不存在的东西。校验、默认值、读取三件事得一起走同一边。
 *
 * 抽成单独模块是因为有两个调用方：`index.ts` 里的采集器本体，和
 * `collector-client.ts`——后者在父进程里也存了一份 units，自己规范化一次。两边各写
 * 一份的话，只在其中一边改就会让子进程收到和父进程不一样的服务名。
 */
export type ServiceManager = {
  kind: 'systemd' | 'launchd';
  normalize(value: unknown): string[];
  read(units: string[]): Promise<ServiceInfo[]>;
  /** 探测这台机器上真的可用——容器里可能装着 systemd 的用户态却没有 /run/systemd。 */
  available(): Promise<boolean>;
  defaults: string[];
};

const SYSTEMD: ServiceManager = {
  kind: 'systemd',
  normalize: normalizeServices,
  read: readServices,
  available: hasSystemd,
  defaults: ['roost-web', 'roost-terminal', 'caddy'],
};

const LAUNCHD: ServiceManager = {
  kind: 'launchd',
  normalize: normalizeLabels,
  read: readLaunchdServices,
  available: async () => true,
  defaults: ['com.roost.terminal', 'com.roost.backend', 'com.roost.web'],
};

/** 这台机器用哪一套；都不是就返回 null，快照里记成 'unsupported'。 */
export function serviceManager(platform = process.platform): ServiceManager | null {
  if (hasLaunchd() || platform === 'darwin') return LAUNCHD;
  return platform === 'linux' ? SYSTEMD : null;
}

/**
 * 规范化服务名。**没有可用的管理器时也要能跑**：配置是用户随时可以改的，
 * 不该因为这台机器碰巧不支持就抛错——那会让保存设置这件事整个失败。
 */
export function normalizeFor(manager: ServiceManager | null, value: unknown): string[] {
  return (manager ?? SYSTEMD).normalize(value);
}
