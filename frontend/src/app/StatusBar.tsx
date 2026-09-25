import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ArrowDownIcon, ArrowUpIcon, CpuChipIcon, CircleStackIcon, SignalIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { Metric } from '@roost/server-monitor/types';
import { useWorkspace } from '../shared/store';
import { getTerminalStatus, getTerminalLatency, subscribeTerminalStatus } from '../features/terminal/public';
import { useServerMonitor } from '../features/server-monitor/store';
import { bytes, compactBytes as compact } from '../shared/bytes';
import type { MonitorTab } from '../features/server-monitor/navigation';
import { SubscriptionSwitcher } from '../features/subscriptions/SubscriptionSwitcher';
import { stableRuntime } from '../shared/runtime';
import { t } from '@roost/i18n';
import './statusBar.css';


/*
  `monitorVisible`：服务器状态面板正开着。

  开着的时候这四个按钮和面板顶部那四张卡是同一组数——CPU、内存、↓、↑，同屏两份。
  它们本来的职责是「面板关着时也能一眼看见，并且点一下直接跳到对应标签页」；
  面板已经在旁边摊开了，两件事都由面板本身承担，留下的只是重复。

  主机、延迟、订阅不撤：面板里没有这几项，不构成重复。
*/
export function StatusBar({ onOpenMonitor, monitorVisible = false }: { onOpenMonitor: (tab: MonitorTab) => void; monitorVisible?: boolean }) {
  const { selectedId } = useWorkspace('selectedId');
  const status = useSyncExternalStore(subscribeTerminalStatus, () => selectedId ? getTerminalStatus(selectedId) : null);
  const measured = useSyncExternalStore(subscribeTerminalStatus, () => selectedId ? getTerminalLatency(selectedId) : null);
  const { summary, failed } = useServerMonitor('summary');
  const m = t.serverMonitor;
  const label = status === 'open' ? t.misc.statusBar.connected : status === 'reconnecting' ? t.misc.statusBar.reconnecting
    : status === 'dead' ? t.misc.statusBar.shellExited : status === 'offline' ? t.session.offline : selectedId ? t.misc.statusBar.connecting : t.misc.statusBar.noSession;
  const latency = status === 'open' && measured && Date.now() - measured.sampledAt < 45000 ? measured.milliseconds : null;
  const cpu = summary?.cpu.data, memory = summary?.memory.data, nic = summary?.network.data?.find(n => n.default);
  const stale = (metric?: Metric<unknown>) => failed || !metric || metric.status !== 'ok' || metric.sampledAt == null || Date.now() - metric.sampledAt > 30000;
  const sampled = (metric?: Metric<unknown>) => !metric?.sampledAt ? m.unavailable : `${stale(metric) ? m.stale : t.statusBar.updated} · ${new Date(metric.sampledAt).toLocaleTimeString()}`;
  const warning = (metric?: Metric<unknown>) => stale(metric) ? <ExclamationTriangleIcon className="size-3 shrink-0" aria-label={sampled(metric)} /> : null;
  /*
    主机名**不回落到 `location.hostname`**。

    那是两个不同的问题：`summary.host.hostname` 是「这台机器叫什么」，`location.hostname`
    是「我的浏览器连到哪个地址」。监控读数偶尔断一下（请求失败、采样过期、重启服务），
    机器就像自己改了名——实测从本机地址访问时它显示成那串回环地址，而这条栏一直在眼前、
    宽度又会被挤，截断之后只剩前几个字符，看上去莫名其妙。从公网地址访问时，它会直接
    把真实 IP 摆在界面上。

    改成记住上一次拿到的名字：机器名不会变，一次读数中断不该重命名任何东西。真的从来
    没拿到过才显示占位符。

    （`ServerMonitorView` 里那处 `location.host` 不动——它的标签就是「访问地址」，
    问的正是那个问题，答得也对。）
  */
  const lastHost = useRef<string | null>(null);
  useEffect(() => { if (summary?.host.hostname) lastHost.current = summary.host.hostname; }, [summary?.host.hostname]);
  const host = summary?.host.hostname ?? lastHost.current ?? '—';
  return <footer aria-label={t.statusBar.title} className="status-bar chrome-surface">
    <div className="status-connection">
      {stableRuntime && <span className="hidden xl:inline" title={window.workbenchConfig?.version}>{t.misc.statusBar.stableBuild}</span>}
      <button type="button" className="status-button status-host" title={`${host} · ${label}`} aria-label={`${host} · ${label}`} onClick={() => onOpenMonitor('overview')}>
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${status === 'open' ? 'bg-text' : status === 'reconnecting' ? 'animate-pulse bg-text' : 'border border-text-dim'}`} />
        <span className="truncate">{status && status !== 'open' ? label : host}</span>
      </button>
      <span className="status-latency" title={latency == null ? t.statusBar.measuring : t.statusBar.latencyHint} aria-label={`${t.statusBar.latency} · ${latency == null ? t.statusBar.measuring : latency + ' ms'}`}>
        <SignalIcon className="size-3" aria-hidden="true" />{latency == null ? '—' : `${latency} ms`}
      </span>
    </div>
    {!monitorVisible && <div className="status-resources">
      <button type="button" className="status-button status-cpu" aria-label={m.cpu} title={`${m.cpuUsage} · ${cpu?.usage == null ? '—' : cpu.usage.toFixed(1) + '%'}\n${cpu?.busyCores == null ? '' : m.busyCores(cpu.busyCores.toFixed(1), cpu.logicalCores) + '\n'}${sampled(summary?.cpu)}`} onClick={() => onOpenMonitor('cpu')}>
        <CpuChipIcon className="size-3.5 shrink-0" aria-hidden="true" /><span>{cpu?.usage == null ? '—' : `${Math.round(cpu.usage)}%`}</span>{warning(summary?.cpu)}
      </button>
      <button type="button" className="status-button status-memory" aria-label={m.memory} title={`${m.memory} · ${bytes(memory?.used)} / ${bytes(memory?.total)}\n${m.available} · ${bytes(memory?.available)}\n${sampled(summary?.memory)}`} onClick={() => onOpenMonitor('memory')}>
        <CircleStackIcon className="size-3.5 shrink-0" aria-hidden="true" /><span>{compact(memory?.used)}<span className="status-memory-total"> / {compact(memory?.total)}</span></span>{warning(summary?.memory)}
      </button>
      <button type="button" className="status-button status-rate" aria-label={m.download} title={`${m.download} · ${nic?.name ?? '—'} · ${bytes(nic?.rxPerSecond)}/s\n${m.networkHint}\n${sampled(summary?.network)}`} onClick={() => onOpenMonitor('network')}>
        <ArrowDownIcon className="size-3.5 shrink-0" aria-hidden="true" /><span>{nic?.rxPerSecond == null ? '—' : `${compact(nic.rxPerSecond)}/s`}</span>{warning(summary?.network)}
      </button>
      <button type="button" className="status-button status-rate" aria-label={m.upload} title={`${m.upload} · ${nic?.name ?? '—'} · ${bytes(nic?.txPerSecond)}/s\n${m.networkHint}\n${sampled(summary?.network)}`} onClick={() => onOpenMonitor('network')}>
        <ArrowUpIcon className="size-3.5 shrink-0" aria-hidden="true" /><span>{nic?.txPerSecond == null ? '—' : `${compact(nic.txPerSecond)}/s`}</span>{warning(summary?.network)}
      </button>
    </div>}
    <div className="status-subscription"><SubscriptionSwitcher /></div>
  </footer>;
}
