import { request } from './request';
import type { ServerSnapshot, ServerSummary } from '@roost/server-monitor/types';
export type { ServerSnapshot } from '@roost/server-monitor/types';
export const fetchServerStatus = (signal: AbortSignal) => request<ServerSnapshot>('/api/server/status', { signal, cache: 'no-store' });
export const fetchServerSummary = (signal: AbortSignal) => request<ServerSummary>('/api/server/summary', { signal, cache: 'no-store' });
export const saveMonitoredServices = (services: string[], signal: AbortSignal) => request<{ services: string[] }>('/api/server/services', {
  method: 'PUT', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ services }),
});

/**
 * 整机在监听的端口 → 各是谁。
 *
 * **按需取，不要挂成轮询**：服务端要 fork 一次 lsof（本机约 28ms + 一次进程表扫描），
 * 点开面板时问一次绰绰有余；挂成每秒一次，进程多的机器上会变味。
 */
export type ListeningService = {
  address: string; port: number | null; pid: number; command: string | null;
  ppid: number | null; parent: string | null;
  /** 控制终端（如 `ttys002`）；没有控制终端的服务为 null。 */
  tty: string | null;
  /** 这个进程监听的全部地址。 */
  addresses: string[];
  /**
   * 对得上的 roost 会话；对不上就是 null——**不猜**。
   *
   * 判据是会话注入的环境变量，tty 只是退路：上线的第一版只比 tty，而实测本机 19 个
   * 监听端点里 tty 一个都没有命中（常驻服务全都脱离了控制终端），这一列当时全是空的。
   *
   * 它可能指向一条**已经关掉**的会话——环境变量活得比会话长。那种情况下 sessions 里
   * 查不到标题，直接显示 id：那正是「关了之后找不回 id」想要的答案。
   */
  terminalId: string | null;
  /** 列表一行用的短命令名，服务端算好（见后端注释）；拿不到进程时为 null。 */
  label: string | null;
  /** 谁够得着：任何网卡 / 仅本机 / 绑在某张网卡上。服务端算好。 */
  scope: 'public' | 'local' | 'interface';
  /**
   * 这个端口上说的是不是 HTTP；只有请求时带了 `probe=1` 才有值。
   *
   * **null 和 false 不是一回事**：null 是「没问」，false 是「问了，不是」。启动台靠
   * false 把 postgres 这类挡在外面，而把 null 当成 false 会让整个列表变空。
   */
  http: boolean | null;
};
export type PortsReport = { supported: boolean; services: ListeningService[] };
/**
 * `probe` 让服务端多问一次每个端口说的是不是 HTTP。
 *
 * **只有启动台要它**：面板列端口，启动台列「点得开的东西」，而后者必须把 postgres 这类
 * 挡在外面。它要给每个端口开一条连接（本机 7 个实测 122ms），所以不是默认行为。
 */
export const fetchListeningPorts = (signal: AbortSignal, options?: { probe?: boolean }) =>
  request<PortsReport>(`/api/server/ports${options?.probe ? '?probe=1' : ''}`, { signal, cache: 'no-store' });
