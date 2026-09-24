import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowsPointingOutIcon, ArrowPathIcon, XMarkIcon, Squares2X2Icon, CpuChipIcon,
  ComputerDesktopIcon, SignalIcon, ServerStackIcon, QueueListIcon, Cog6ToothIcon,
  CircleStackIcon, ArrowDownIcon, ArrowUpIcon, ClockIcon, GlobeAltIcon,
  ServerIcon, InformationCircleIcon, ExclamationTriangleIcon, ArrowsRightLeftIcon,
  ChartBarIcon, BoltIcon, Square3Stack3DIcon, FireIcon, StarIcon, MagnifyingGlassIcon,
  HashtagIcon, CheckIcon, PauseIcon, PlayIcon, StopIcon, LinkIcon, UserIcon, ArrowTrendingUpIcon, LifebuoyIcon, CommandLineIcon,
} from '@heroicons/react/24/outline';
import { t } from '@roost/i18n';
import type { Metric, ServerSnapshot, ServiceInfo, DiskInfo } from '@roost/server-monitor/types';
import { fetchListeningPorts, saveMonitoredServices, type ListeningService, type PortsReport } from '../../shared/api/serverMonitor';
import { useWorkspace } from '../../shared/store';
import { useLibraryPresentation } from '../../shared/ui/useLibraryPresentation';
import { useServerMonitor, refreshServerMonitor } from './store';
import type { MonitorTab as Tab, MonitorTarget } from './navigation';
import { bytes, percentage, uptime } from './format';
import { emptyHistory, sampleHistory, segments, type History, type Point } from './history';
import './monitor.css';

type Icon = typeof CpuChipIcon;
const tabs: { id: Tab; icon: Icon }[] = [
  { id: 'overview', icon: Squares2X2Icon }, { id: 'cpu', icon: CpuChipIcon },
  { id: 'memory', icon: CircleStackIcon }, { id: 'gpu', icon: ComputerDesktopIcon }, { id: 'network', icon: SignalIcon },
  { id: 'disks', icon: ServerStackIcon }, { id: 'processes', icon: QueueListIcon },
  { id: 'services', icon: Cog6ToothIcon }, { id: 'ports', icon: SignalIcon },
];
/*
  这个面板原来有七档字号：10、11、12、14、18、30，外加几处没写字号的地方（继承 13）。
  差 1px 的那几档不携带任何意思——同一张磁盘卡里 mount 是 12、紧挨着的 device 是 11、
  再下面的 used/total 也是 11，选哪个纯粹看当时谁写的。

  收敛到体系里的两档：
    text-caption(11)  读数和它们的标签——这一整个面板就是「状态读数」
    text-body(13)     句子和控件：加载/失败/空状态、输入框、按钮
  大数字不在这两档里：TrendCard 的 text-lg 和 CPU/内存页的 text-3xl 是**展示数字**，
  靠尺寸和周围的读数拉开层次，那是有意的，留着。
*/
const button = 'rounded-md border border-border p-1.5 text-body text-text-dim hover:bg-bg-hover hover:text-text disabled:opacity-40';
const box = 'rounded-lg border border-border/70 bg-bg-raised/50 p-3';
function Glyph({ icon: Icon, label, className = '', size = 'size-4' }: { icon: Icon; label: string; className?: string; size?: string }) {
  return <span title={label} aria-label={label} className={`inline-flex shrink-0 items-center ${className}`}><Icon className={size} aria-hidden="true" /></span>;
}
function Stat({ icon, label, children, className = '' }: { icon: Icon; label: string; children: ReactNode; className?: string }) {
  return <div title={label} className={`flex min-w-0 items-center gap-2 text-caption tabular-nums ${className}`}><Glyph icon={icon} label={label} className="text-text-dim" /><span className="min-w-0 break-all">{children}</span></div>;
}
/*
  值本身说不出自己是什么的格子用这个。

  `5.2 KiB/s`、`68.9%` 这种带单位的值，单位就是标签；而 `733`、`89` 是裸整数，
  一行并排六个只靠图标区分，不标出来就只能把鼠标停上去一个个试。`Stat` 的标签
  只活在 title/aria-label 里——读屏和悬停拿得到，眼睛拿不到，这里给眼睛补一行。
*/
function LabeledStat({ icon, label, short, children }: { icon: Icon; label: string; short: string; children: ReactNode }) {
  return <div title={label} className="flex min-w-0 flex-col gap-0.5">
    <span className="flex min-w-0 items-center gap-1.5 text-caption text-text-dim">
      <Glyph icon={icon} label={label} size="size-3.5" /><span className="truncate">{short}</span>
    </span>
    <span className="min-w-0 break-all text-caption tabular-nums">{children}</span>
  </div>;
}
function Bar({ value }: { value: number | null | undefined }) {
  return <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-text/8"><div className={`h-full rounded-full transition-[width] duration-300 bg-text/80`} style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></div>;
}
function Health({ metric }: { metric: Metric<unknown> }) {
  if (metric.status === 'ok') return null;
  const label = metric.data === null ? t.serverMonitor.unavailable : `${t.serverMonitor.stale} · ${metric.sampledAt == null ? '—' : new Date(metric.sampledAt).toLocaleTimeString()}`;
  return <Glyph icon={ExclamationTriangleIcon} label={label} className="text-text" />;
}
function MetricSection<T>({ metric, children }: { metric: Metric<T>; children: (data: T) => ReactNode }) {
  return <>{metric.status !== 'ok' && <div role="status" className="mb-2 flex items-center gap-2 text-body text-text-dim"><Health metric={metric} />{metric.data === null ? t.serverMonitor.unavailable : t.serverMonitor.stale}</div>}{metric.data !== null && children(metric.data)}</>;
}
function Sparkline({ points, percent = false }: { points: Point[]; percent?: boolean }) {
  const lines = segments(points, percent ? 100 : undefined);
  return <svg viewBox="0 0 100 30" className="mt-2 h-10 w-full text-text" preserveAspectRatio="none" aria-hidden="true"><path d="M0 29 H100 M0 15 H100" fill="none" stroke="currentColor" opacity=".12" vectorEffect="non-scaling-stroke" />{lines.map((line, i) => <polyline key={i} fill="none" stroke="currentColor" strokeWidth="1.3" vectorEffect="non-scaling-stroke" points={line} />)}</svg>;
}
function Count({ value }: { value: number | null | undefined }) { return <>{value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 1 })}</>; }
function DiskCard({ disk: d, detail = false }: { disk: DiskInfo; detail?: boolean }) {
  const m = t.serverMonitor;
  return <div className={box}>
    <div className="flex items-center justify-between gap-2"><Stat icon={ServerStackIcon} label={m.disks}>{d.mount}</Stat><span className="shrink-0 text-caption tabular-nums">{percentage(d.usage)}</span></div>
    {detail && <p className="mt-2 break-all text-caption text-text-dim">{d.device} · {d.type} · {d.writable == null ? '—' : d.writable ? 'R/W' : 'R/O'}</p>}
    <Bar value={d.usage} />
    <div title={`${m.used} / ${m.total}`} className="mt-2 text-caption tabular-nums text-text-dim">{bytes(d.used)} / {bytes(d.size)}</div>
    {detail && <Stat icon={Square3Stack3DIcon} label={m.available} className="mt-2">{bytes(d.available)}</Stat>}
  </div>;
}
function serviceState(s: ServiceInfo) {
  const m = t.serverMonitor;
  if (s.load === 'not-found') return m.notFound;
  return ({ active: m.active, inactive: m.inactive, activating: m.activating, deactivating: m.deactivating, failed: m.failedState } as Record<string, string>)[s.active] ?? m.unknown;
}
function TrendCard({ icon, label, value, detail, series, percent, metric, onClick }: { icon: Icon; label: string; value: string; detail?: ReactNode; series: Point[]; percent?: boolean; metric: Metric<unknown>; onClick?: () => void }) {
  const body = <>
    <div className="flex items-center justify-between"><Glyph icon={icon} label={label} /><Health metric={metric} /></div>
    <p className="mt-2 break-all text-lg font-semibold tabular-nums">{value}</p>
    {detail && <div className="mt-1 text-caption tabular-nums text-text-dim">{detail}</div>}
    <Sparkline points={series} percent={percent} />
  </>;
  return onClick ? <button type="button" onClick={onClick} title={label} aria-label={label} className={`${box} min-w-0 text-left hover:bg-bg-hover`}>{body}</button> : <div title={label} className={`${box} min-w-0`}>{body}</div>;
}
/*
  哪个端口上跑着什么。

  **这是整机视角，不是「这条终端起了什么」**——那个在终端面板里另有一份，按 tty 过滤。
  人想知道「8080 是谁占着」的时候，往往正因为那玩意不是从当前终端起的：上周起的、
  或者被 launchd 拉起来的。

  点开才取，不跟着监控那条轮询走：服务端要 fork 一次 lsof。
*/
/*
  一行端口，点开看详情。

  **这一块是按右侧面板那个宽度（约 300px）设计的，不是按桌面表格。** 第一版排成四列
  （端口 / 地址 / 命令 / pid），在真实宽度下地址列独占三分之一，而它旁边就是端口——
  `5173` 和 `*:5173` 并排放着，那一列里唯一不重复的信息是冒号前面那一截。代价是命令名
  被挤成 `postg…`、`Goog…`，整块面板二十多行长得一模一样，什么也读不出来。

  改成两行：第一行是「几号端口、是什么」，第二行是「谁起的、多大范围」。地址那一截收成
  一个词（公开 / 仅本机 / 指定网卡），完整地址进展开区。
*/
function PortRow({ service, title }: { service: ListeningService; title: string | null }) {
  const m = t.serverMonitor;
  const { selectSession } = useWorkspace('selectSession');
  const [open, setOpen] = useState(false);
  const field = (label: string, value: ReactNode) => (
    <div className="flex gap-2"><span className="w-20 shrink-0 text-text-dim/70">{label}</span>
      <span className="min-w-0 flex-1 break-all">{value}</span></div>
  );
  const scopeLabel = { public: m.portsScopePublic, local: m.portsScopeLocal, interface: m.portsScopeInterface }[service.scope];
  /*
    「公开」要看得见：这台机器从公网访问，一个本以为只监听本机、实际绑在 `*` 上的端口
    是真实的暴露面。「仅本机」是常态，不该抢注意力，所以只有它是灰的。
  */
  const scopeTone = service.scope === 'local' ? 'text-text-dim/60' : 'text-warning';
  return (
    <li className="rounded-md border border-transparent hover:border-border">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="flex w-full min-w-0 flex-col gap-0.5 px-1 py-1 text-left text-caption">
        <span className="flex w-full min-w-0 items-baseline gap-2">
          <span className="w-12 shrink-0 text-right font-mono tabular-nums text-text">{service.port ?? '—'}</span>
          {/* 命令名要拿到剩下的全部宽度——它是这一行里唯一能让人认出「这是什么」的东西。 */}
          <span className="min-w-0 flex-1 truncate text-text" title={service.command ?? undefined}>{service.label ?? m.portsGone}</span>
        </span>
        <span className="flex w-full min-w-0 items-baseline gap-2 pl-14 text-text-dim">
          <span className={`shrink-0 ${scopeTone}`} title={m.portsScopeHint[service.scope]}>{scopeLabel}</span>
          <span className="min-w-0 flex-1 truncate">
            {/*
              归属挪到列表行里——它原来只在展开区，而那正是人扫这张表时最想知道的一格
              （「这东西是我在哪儿起的」）。查不到标题说明那条会话已经关了，显示 id：
              环境变量活得比会话长，而 id 正是这时候唯一能用的线索。
            */}
            {service.terminalId ? (title ?? `${service.terminalId}${m.portsSessionGone}`) : service.tty ?? ''}
          </span>
          <span className="shrink-0 font-mono tabular-nums text-text-dim/50">{service.pid}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-border/50 px-2 py-1.5 text-caption text-text-dim">
          {field(m.portsCommand, <span className="font-mono">{service.command ?? m.portsGone}</span>)}
          {field(m.portsAddress, <span className="font-mono">{service.address}</span>)}
          {field(m.portsPid, <span className="font-mono tabular-nums">{service.pid}</span>)}
          {service.parent && field(m.portsParent,
            <span className="font-mono">{service.parent}{service.ppid === null ? '' : ` · ${service.ppid}`}</span>)}
          {service.addresses.length > 1 && field(m.portsAll,
            <span className="font-mono">{service.addresses.join('  ')}</span>)}
          {field(m.portsTerminal, service.terminalId
            ? <button type="button" className="rounded px-1 text-left text-text hover:bg-bg-hover"
                onClick={() => selectSession(service.terminalId!)}>
                {title ?? service.terminalId} · {m.portsGoTerminal}
              </button>
            /* 不属于任何 roost 会话（开机自启那些）——说清楚，别留空。tty 认得出时给 tty：
               那是从系统终端或 ssh 起的，和「认不出」不是一件事。 */
            : <span>{service.tty ?? m.portsNoTerminal}</span>)}
        </div>
      )}
    </li>
  );
}

function Ports() {
  const m = t.serverMonitor;
  const { sessions } = useWorkspace('sessions');
  const [report, setReport] = useState<PortsReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [showOthers, setShowOthers] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    fetchListeningPorts(controller.signal)
      .then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [revision]);

  if (failed) return <div className="text-caption text-danger">{m.portsFailed}</div>;
  if (!report) return <div className="text-caption text-text-dim">{m.portsLoading}</div>;
  /*
    **「看不到」和「一个都没有」必须分开说。** lsof 没装、被策略挡住、超时都属于前者，
    而把它画成「什么都没跑」是在撒谎——用户会据此以为端口是空的。
  */
  if (!report.supported) return <div className="text-caption text-text-dim">{m.portsUnsupported}</div>;
  if (!report.services.length) return <div className="text-caption text-text-dim">{m.portsEmpty}</div>;
  /*
    **分成两组，「其他」默认收起。** 本机 23 个监听端点里 12 个是浏览器的 helper 和开机
    自启的服务——它们把真正要看的那几行埋在中间。收起来不是隐藏：计数还在，一下就能展开。
  */
  const titles = new Map(sessions.map(session => [session.id, session.title]));
  const mine = report.services.filter(service => service.terminalId);
  const others = report.services.filter(service => !service.terminalId);
  const list = (services: typeof report.services) => (
    <ul className="space-y-0.5">
      {services.map(service => (
        <PortRow key={`${service.pid}:${service.address}`} service={service}
          title={service.terminalId ? titles.get(service.terminalId) ?? null : null} />
      ))}
    </ul>
  );
  const heading = (text: string) => <div className="px-1 pt-1 text-caption font-medium text-text-dim/70">{text}</div>;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-caption text-text-dim">
        <span>{m.portsScope}</span>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-bg-hover hover:text-text"
          onClick={() => setRevision(value => value + 1)}>{m.portsRefresh}</button>
      </div>
      {mine.length > 0 && <>{heading(m.portsMine)}{list(mine)}</>}
      {others.length > 0 && (
        <>
          <button type="button" aria-expanded={showOthers} onClick={() => setShowOthers(value => !value)}
            className="w-full px-1 pt-1 text-left text-caption font-medium text-text-dim/70 hover:text-text">
            {m.portsOthers} · {others.length}
          </button>
          {showOthers && list(others)}
        </>
      )}
    </div>
  );
}

function Details({ snapshot: s, tab, history, onTab }: { snapshot: ServerSnapshot; tab: Tab; history: History; onTab: (tab: Tab) => void }) {
  const m = t.serverMonitor;
  const [filter, setFilter] = useState(''), [sort, setSort] = useState('cpu'), [selectedPid, setSelectedPid] = useState<number | null>(null);
  if (tab === 'overview') {
    const c = s.cpu.data, memory = s.memory.data, nic = s.network.data?.find(n => n.default), io = s.diskActivity?.data;
    const disks = [...(s.disks.data ?? [])].sort((a, b) => Number(b.mount === '/') - Number(a.mount === '/') || b.usage - a.usage).slice(0, 3);
    return <div className="space-y-3">
      <div className={`${box} space-y-2.5`}>
        <div className="flex items-center justify-between gap-2"><Stat icon={ServerIcon} label={m.hostname} className="font-semibold">{s.host.hostname}</Stat><Glyph icon={InformationCircleIcon} label={m.historyHint} className="text-text-dim" /></div>
        <Stat icon={ComputerDesktopIcon} label={m.system}>{s.system?.data ? `${s.system.data.distro} ${s.system.data.release}` : s.host.platform} · {s.host.arch}</Stat>
        {s.system?.data && <Stat icon={s.system.data.virtual ? Square3Stack3DIcon : ServerStackIcon} label={s.system.data.virtual ? m.virtualMachine : m.hardware}>{s.system.data.manufacturer} {s.system.data.model}</Stat>}
        <div className="flex flex-wrap gap-x-4 gap-y-2"><Stat icon={ClockIcon} label={`${m.uptime} · ${new Date(Date.now() - s.host.uptime * 1000).toLocaleString()}`}>{uptime(s.host.uptime)}</Stat><Stat icon={GlobeAltIcon} label={m.accessAddress}>{location.host}</Stat></div>
        {nic?.ipv4 && <Stat icon={SignalIcon} label={`${nic.name} · IPv4`}>{nic.ipv4}</Stat>}
        <div className="flex flex-wrap gap-x-4 gap-y-2"><Stat icon={CommandLineIcon} label={m.kernel}>{s.host.release}</Stat>{s.system?.data && <Stat icon={GlobeAltIcon} label={m.timezone}>{s.system.data.timezone}</Stat>}</div>
      </div>
      <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-3">
        <TrendCard icon={CpuChipIcon} label={m.cpuUsage} value={percentage(c?.usage)} detail={c?.busyCores == null ? '—' : m.busyCores(c.busyCores.toFixed(1), c.logicalCores)} series={history.cpu.points} percent metric={s.cpu} onClick={() => onTab('cpu')} />
        <TrendCard icon={CircleStackIcon} label={m.memory} value={percentage(memory ? memory.used / memory.total * 100 : null)} detail={`${bytes(memory?.used)} / ${bytes(memory?.total)}`} series={history.memory.points} percent metric={s.memory} onClick={() => onTab('memory')} />
        <TrendCard icon={ArrowDownIcon} label={m.download} value={`${bytes(nic?.rxPerSecond)}/s`} detail={<span title={m.networkHint}>{nic?.name ?? '—'} · ↓ {bytes(nic?.rxBytes)}</span>} series={history.rx.points} metric={s.network} onClick={() => onTab('network')} />
        <TrendCard icon={ArrowUpIcon} label={m.upload} value={`${bytes(nic?.txPerSecond)}/s`} detail={<span title={m.networkHint}>{nic?.name ?? '—'} · ↑ {bytes(nic?.txBytes)}</span>} series={history.tx.points} metric={s.network} onClick={() => onTab('network')} />
        {s.diskActivity && <><TrendCard icon={ServerStackIcon} label={m.diskRead} value={`${bytes(io?.readRate)}/s`} detail={<><Count value={io?.readIops} /> IOPS · R</>} series={history.read.points} metric={s.diskActivity} onClick={() => onTab('disks')} /><TrendCard icon={ServerStackIcon} label={m.diskWrite} value={`${bytes(io?.writeRate)}/s`} detail={<><Count value={io?.writeIops} /> IOPS · W</>} series={history.write.points} metric={s.diskActivity} onClick={() => onTab('disks')} /></>}
      </div>
      <div className="grid gap-3 @xl:grid-cols-2">
        <div className={`${box} grid grid-cols-2 gap-3`}>
          <LabeledStat icon={QueueListIcon} label={m.processes} short={m.short.processes}><Count value={s.processes.data?.total} /></LabeledStat><LabeledStat icon={PlayIcon} label={m.runningProcesses} short={m.short.running}><Count value={s.processes.data?.running} /></LabeledStat>
          <LabeledStat icon={LinkIcon} label={m.connections} short={m.short.connections}><Count value={s.connections?.data?.total} /></LabeledStat><LabeledStat icon={SignalIcon} label={m.listenPorts} short={m.short.listening}><Count value={s.connections?.data?.listening} /></LabeledStat>
          <LabeledStat icon={ArrowsRightLeftIcon} label={m.swap} short={m.short.swap}>{bytes(memory?.swapUsed)} / {bytes(memory?.swapTotal)}</LabeledStat><LabeledStat icon={FireIcon} label={m.temperature} short={m.short.temperature}>{s.thermal?.data?.temperature == null ? '—' : `${s.thermal.data.temperature} °C`}</LabeledStat>
        </div>
        <div className="space-y-2">{disks.map(d => <DiskCard key={d.mount} disk={d} />)}</div>
        {s.processes.data && <div className={`${box} space-y-2`}><button className="mb-1 flex w-full items-center justify-between text-caption" onClick={() => onTab('processes')} title={m.processes}><Glyph icon={QueueListIcon} label={m.topProcesses} /><span className="text-text-dim">CPU / RSS</span></button>{s.processes.data.list.slice(0, 5).map(p => <div className="flex min-w-0 items-center gap-2 text-caption" key={p.pid}><span className="min-w-0 flex-1 truncate" title={`${p.name} · PID ${p.pid}`}>{p.name}</span><span className="tabular-nums">{percentage(p.cpu)}</span><span className="w-16 text-right tabular-nums text-text-dim">{bytes(p.memory)}</span></div>)}</div>}
        {s.serviceManager !== 'unsupported' && <div className={`${box} space-y-3`}><button title={m.services} aria-label={m.services} onClick={() => onTab('services')}><Cog6ToothIcon className="size-4" /></button>{s.services.data?.slice(0, 5).map(service => <div className="flex min-w-0 items-center gap-2 text-caption" key={service.unit}><Glyph icon={service.active === 'active' ? CheckIcon : service.active === 'failed' ? ExclamationTriangleIcon : StopIcon} label={serviceState(service)} /><span className="min-w-0 flex-1 truncate" title={service.unit}>{service.unit.replace(/\.service$/, '')}</span><span className="text-text-dim">{serviceState(service)}</span></div>)}</div>}
      </div>
    </div>;
  }
  if (tab === 'cpu') return <MetricSection metric={s.cpu}>{c => <div className="space-y-3">
    <div className={box}>
      <Stat icon={CpuChipIcon} label={m.cpu} className="font-medium">{c.model}</Stat>
      <div className="my-4 flex flex-wrap items-baseline gap-x-4 gap-y-1"><span className="text-3xl font-semibold tabular-nums" title={m.cpuUsage}>{percentage(c.usage)}</span><span className="text-caption tabular-nums text-text-dim" title={m.logical}>{c.busyCores == null ? '—' : c.busyCores.toFixed(2)} / {c.logicalCores}</span></div>
      <div className="flex flex-wrap gap-x-5 gap-y-3"><Stat icon={Square3Stack3DIcon} label={m.logical}>{c.logicalCores} T</Stat><Stat icon={CpuChipIcon} label={m.physical}>{c.physicalCores ?? '—'} C</Stat><Stat icon={BoltIcon} label={m.availableCores}>{c.availableCores}</Stat><Stat icon={ServerIcon} label={m.sockets}>{c.sockets ?? '—'}</Stat></div>
      <Sparkline points={history.cpu.points} percent />
      <Stat icon={ChartBarIcon} label={m.load} className="mt-2">{c.loadAverage.map(n => n.toFixed(2)).join(' / ')}</Stat>
    </div>
    <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4">{[{ label: m.userCpu, value: c.user }, { label: m.systemCpu, value: c.system }, { label: m.idleCpu, value: c.idle }, { label: m.stealCpu, value: c.steal }].map(item => <div key={item.label} className={box}><p className="text-caption text-text-dim">{item.label}</p><p className="mt-1 text-body tabular-nums">{percentage(item.value)}</p><Bar value={item.value} /></div>)}</div>
    <div className={`${box} flex flex-wrap gap-x-5 gap-y-3`}><Stat icon={BoltIcon} label={m.frequency}><Count value={s.thermal?.data?.speed} /> GHz</Stat><Stat icon={ArrowTrendingUpIcon} label={m.baseMaxFrequency}><Count value={c.speedBase} /> / <Count value={c.speedMax} /> GHz</Stat><Stat icon={FireIcon} label={m.temperature}>{s.thermal?.data?.temperature == null ? '—' : `${s.thermal.data.temperature} °C`}</Stat><Stat icon={CircleStackIcon} label={m.cpuCache}>{c.cache ? `L1d ${bytes(c.cache.l1d)} · L1i ${bytes(c.cache.l1i)} · L2 ${bytes(c.cache.l2)} · L3 ${bytes(c.cache.l3)}` : '—'}</Stat></div>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(82px,1fr))] gap-2" aria-label={m.cores}>{c.cores.map((n, i) => <div key={i} className="rounded-md border border-border/70 p-2" title={`CPU ${i}: ${percentage(n)}`}><div className="flex justify-between gap-1 text-caption text-text-dim"><span>#{i}</span><span>{n == null ? '—' : `${Math.round(n)}%`}</span></div><Bar value={n} />{s.thermal?.data?.coreSpeeds[i] != null && <p className="mt-1 text-caption tabular-nums text-text-dim">{s.thermal.data.coreSpeeds[i]?.toFixed(2)} GHz</p>}</div>)}</div>
  </div>}</MetricSection>;
  if (tab === 'memory') return <MetricSection metric={s.memory}>{memory => <div className="space-y-3">
    <div className={box}><Stat icon={CircleStackIcon} label={m.memory} className="font-medium">{bytes(memory.used)} / {bytes(memory.total)}</Stat><p className="mt-3 text-3xl font-semibold tabular-nums">{percentage(memory.used / memory.total * 100)}</p><Sparkline points={history.memory.points} percent /><div className="mt-2 flex items-center gap-2"><Glyph icon={InformationCircleIcon} label={m.memoryHint} /><span className="text-caption text-text-dim">{m.historyWindow}</span></div></div>
    <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4">{[{ label: m.available, value: memory.available }, { label: m.free, value: memory.free }, { label: m.activeMemory, value: memory.active }, { label: m.cached, value: memory.cached }, { label: m.buffers, value: memory.buffers }, { label: 'Slab', value: memory.slab }, { label: m.dirty, value: memory.dirty }, { label: m.writeback, value: memory.writeback }].map(item => <div className={box} key={item.label}><p className="text-caption text-text-dim">{item.label}</p><p className="mt-1 text-body font-medium tabular-nums">{bytes(item.value)}</p></div>)}</div>
    <div className={box}><Stat icon={ArrowsRightLeftIcon} label={m.swap}>{bytes(memory.swapUsed)} / {bytes(memory.swapTotal)}</Stat><Bar value={memory.swapTotal > 0 ? memory.swapUsed / memory.swapTotal * 100 : 0} /><p className="mt-2 text-caption tabular-nums text-text-dim" title={m.available}>{bytes(memory.swapTotal - memory.swapUsed)}</p></div>
  </div>}</MetricSection>;
  if (tab === 'gpu') return <MetricSection metric={s.gpu}>{gpus => <div className="grid gap-3 @xl:grid-cols-2">
    {gpus.length === 0 && <p className="text-body text-text-dim">{m.noGpu}</p>}
    {gpus.map((g, i) => <div className={`${box} space-y-3`} key={i}>
      <div className="flex items-center justify-between gap-2"><Stat icon={ComputerDesktopIcon} label={m.gpu} className="font-medium">{g.model}</Stat><Glyph icon={InformationCircleIcon} label={m.gpuHint} className="text-text-dim" /></div>
      <p className="text-caption text-text-dim">{g.vendor} · {g.bus || '—'}</p>
      <Stat icon={ChartBarIcon} label={m.used}>{percentage(g.usage)}</Stat><Bar value={g.usage} />
      <Stat icon={CircleStackIcon} label={g.sharedMemory ? m.sharedMemory : m.vram}>{bytes(g.memoryUsed)} / {bytes(g.memoryTotal)}</Stat><Bar value={g.memoryTotal && g.memoryUsed != null ? g.memoryUsed / g.memoryTotal * 100 : null} />
      <div className="grid grid-cols-2 gap-3"><Stat icon={FireIcon} label={m.temperature}>{g.temperature == null ? '—' : `${g.temperature} °C`}</Stat><Stat icon={CpuChipIcon} label={m.cores}>{g.cores ?? '—'}</Stat><Stat icon={BoltIcon} label={m.power}><Count value={g.power} /> / <Count value={g.powerLimit} /> W</Stat><Stat icon={ArrowTrendingUpIcon} label={m.gpuClock}><Count value={g.clockCore} /> / <Count value={g.clockMemory} /> MHz</Stat><Stat icon={LifebuoyIcon} label={m.fan}>{percentage(g.fan)}</Stat><Stat icon={Cog6ToothIcon} label={m.driver}>{g.driver || '—'}</Stat></div>
    </div>)}
  </div>}</MetricSection>;
  if (tab === 'network') return <div className="space-y-3">
    <div className="grid grid-cols-2 gap-2"><TrendCard icon={ArrowDownIcon} label={m.download} value={`${bytes(s.network.data?.find(n => n.default)?.rxPerSecond)}/s`} series={history.rx.points} metric={s.network} /><TrendCard icon={ArrowUpIcon} label={m.upload} value={`${bytes(s.network.data?.find(n => n.default)?.txPerSecond)}/s`} series={history.tx.points} metric={s.network} /></div>
    {s.connections && <MetricSection metric={s.connections}>{connections => <div className={box}><div className="flex flex-wrap gap-x-5 gap-y-3"><Stat icon={LinkIcon} label={m.connections}>{connections.total}</Stat><Stat icon={CheckIcon} label="ESTABLISHED">{connections.established}</Stat><Stat icon={ClockIcon} label="TIME_WAIT">{connections.timeWait}</Stat><Stat icon={SignalIcon} label={m.listenPorts}>{connections.listening}</Stat><Stat icon={ArrowsRightLeftIcon} label="UDP">{connections.udp}</Stat></div></div>}</MetricSection>}
    <MetricSection metric={s.network}>{interfaces => <div className="grid gap-3 @xl:grid-cols-2">
      {!interfaces.length && <p>{m.noNetwork}</p>}
      {[...interfaces].sort((a, b) => Number(b.default) - Number(a.default)).map(n => <div className={`${box} space-y-3`} key={n.name}>
        <div className="flex items-center gap-2"><Stat icon={SignalIcon} label={m.network} className="font-semibold">{n.name}</Stat>{n.default && <Glyph icon={StarIcon} label={m.defaultInterface} />}<span title={n.state} aria-label={n.state} className={`ml-auto size-2 rounded-full ${n.state === 'up' ? 'bg-text' : 'border border-text-dim'}`} /></div>
        {n.ipv4 && <Stat icon={GlobeAltIcon} label="IPv4">{n.ipv4}</Stat>}{n.ipv6 && <Stat icon={GlobeAltIcon} label="IPv6">{n.ipv6}</Stat>}
        <Stat icon={HashtagIcon} label="MAC">{n.mac || '—'}</Stat>
        <div className="flex flex-wrap gap-x-4 gap-y-2"><Stat icon={BoltIcon} label={m.linkSpeed}><Count value={n.speed} /> Mbps</Stat><Stat icon={Square3Stack3DIcon} label="MTU">{n.mtu ?? '—'}</Stat><Stat icon={ArrowsRightLeftIcon} label={m.linkType}>{n.type || '—'} · {n.duplex || '—'}</Stat></div>
        <div className="grid grid-cols-2 gap-2"><Stat icon={ArrowDownIcon} label={m.download}>{bytes(n.rxPerSecond)}/s</Stat><Stat icon={ArrowUpIcon} label={m.upload}>{bytes(n.txPerSecond)}/s</Stat></div>
        <div className="border-t border-border/60 pt-2"><Stat icon={ArrowsRightLeftIcon} label={m.traffic}><span title={m.download}>↓ {bytes(n.rxBytes)}</span><span title={m.upload} className="ml-3">↑ {bytes(n.txBytes)}</span></Stat></div>
        <div className="grid grid-cols-2 gap-2"><Stat icon={ExclamationTriangleIcon} label={m.errors}>↓ <Count value={n.rxErrors} /> ↑ <Count value={n.txErrors} /></Stat><Stat icon={XMarkIcon} label={m.dropped}>↓ <Count value={n.rxDropped} /> ↑ <Count value={n.txDropped} /></Stat></div>
      </div>)}
    </div>}</MetricSection>
    {s.connections?.data && <div className={`${box} space-y-2`}><div className="flex items-center justify-between"><Stat icon={SignalIcon} label={m.listenPorts}>{s.connections.data.listeners.length} / {s.connections.data.listening}</Stat>{s.connections.data.limited && <Glyph icon={InformationCircleIcon} label={m.portLimit} />}</div><div className="divide-y divide-border/50">{s.connections.data.listeners.map((l, i) => <div key={i} className="flex min-w-0 items-start justify-between gap-2 py-2 text-caption"><div className="min-w-0"><p className="break-all font-mono">{l.address.includes(':') ? `[${l.address}]` : l.address}:{l.port}</p><p className="text-text-dim">{l.protocol}</p></div><div className="min-w-0 text-right"><p className="break-all">{l.process || '—'}</p><p className="text-text-dim">{l.pid ?? '—'}</p></div></div>)}</div></div>}
  </div>;
  if (tab === 'disks') return <div className="space-y-3">
    {s.diskActivity && <MetricSection metric={s.diskActivity}>{io => <><div className="grid grid-cols-2 gap-2"><TrendCard icon={ArrowDownIcon} label={m.diskRead} value={`${bytes(io.readRate)}/s`} detail={<><Count value={io.readIops} /> IOPS · R</>} series={history.read.points} metric={s.diskActivity} /><TrendCard icon={ArrowUpIcon} label={m.diskWrite} value={`${bytes(io.writeRate)}/s`} detail={<><Count value={io.writeIops} /> IOPS · W</>} series={history.write.points} metric={s.diskActivity} /></div><div className={`${box} flex flex-wrap gap-4`}><Stat icon={ArrowDownIcon} label={m.totalRead}>{bytes(io.readBytes)}</Stat><Stat icon={ArrowUpIcon} label={m.totalWrite}>{bytes(io.writeBytes)}</Stat><Glyph icon={InformationCircleIcon} label={m.diskIoHint} className="text-text-dim" /></div></>}</MetricSection>}
    <MetricSection metric={s.disks}>{disks => <div className="grid gap-3 @xl:grid-cols-2">{!disks.length && <p>{m.noDisks}</p>}{disks.map(d => <DiskCard disk={d} detail key={d.mount} />)}</div>}</MetricSection>
  </div>;
  if (tab === 'ports') return <Ports />;
  if (tab === 'processes') return <MetricSection metric={s.processes}>{p => {
    const rows = p.list.filter(row => `${row.name} ${row.pid} ${row.user}`.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => sort === 'memory' ? b.memory - a.memory : (b.cpu ?? 0) - (a.cpu ?? 0));
    const selected = p.list.find(row => row.pid === selectedPid);
    return <div className="space-y-3">
      <div className={`${box} flex flex-wrap gap-x-5 gap-y-3`}><Stat icon={PlayIcon} label={m.runningProcesses}>{p.running}</Stat><Stat icon={PauseIcon} label={m.sleepingProcesses}>{p.sleeping ?? '—'}</Stat><Stat icon={StopIcon} label={m.blockedProcesses}>{p.blocked ?? '—'}</Stat><Stat icon={ExclamationTriangleIcon} label={m.zombieProcesses}>{p.zombie ?? '—'}</Stat></div>
      <div className="flex items-center gap-2 rounded-md border border-border bg-bg px-2"><Glyph icon={MagnifyingGlassIcon} label={m.processFilter} className="text-text-dim" /><input aria-label={m.processFilter} placeholder={m.processFilter} value={filter} onChange={e => setFilter(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-body" /></div>
      <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><Stat icon={QueueListIcon} label={m.processCount(rows.length, p.total)}>{rows.length} / {p.total}</Stat>{p.limited && <Glyph icon={InformationCircleIcon} label={m.processLimit} className="text-text-dim" />}</div><div className="flex gap-1">{[{ id: 'cpu', icon: CpuChipIcon, label: m.processCpu }, { id: 'memory', icon: CircleStackIcon, label: m.processMemory }].map(item => <button key={item.id} aria-label={item.label} title={item.label} aria-pressed={sort === item.id} className={`${button} ${sort === item.id ? 'bg-text/10 text-text' : ''}`} onClick={() => setSort(item.id)}><item.icon className="size-4" /></button>)}</div></div>
      {selected && <div className={`${box} space-y-3`}><div className="flex items-start justify-between gap-2"><Stat icon={CommandLineIcon} label={m.processName}>{selected.name}</Stat><button className={button} aria-label={m.closeDetail} title={m.closeDetail} onClick={() => setSelectedPid(null)}><XMarkIcon className="size-3" /></button></div><div className="grid grid-cols-2 gap-3 @xl:grid-cols-4"><Stat icon={HashtagIcon} label="PID / PPID">{selected.pid} / {selected.parentPid ?? '—'}</Stat><Stat icon={UserIcon} label={m.user}>{selected.user}</Stat><Stat icon={CircleStackIcon} label="RSS / VSZ">{bytes(selected.memory)} / {bytes(selected.virtualMemory)}</Stat><Stat icon={Square3Stack3DIcon} label={m.threads}>{selected.threads ?? '—'}</Stat><Stat icon={ChartBarIcon} label={m.priority}>{selected.priority ?? '—'}</Stat><Stat icon={PlayIcon} label={m.state}>{selected.state}</Stat></div></div>}
      <div className="overflow-x-auto"><table className="w-full text-left text-caption"><thead className="text-text-dim"><tr><th className="py-2"><Glyph icon={QueueListIcon} label={m.processName} /></th><th className="px-2 text-right"><Glyph icon={CpuChipIcon} label={m.processCpuHint} /></th><th className="text-right"><Glyph icon={CircleStackIcon} label={m.memory} /></th></tr></thead><tbody>{rows.map(row => <tr key={row.pid} className={`border-t border-border/50 ${row.pid === selectedPid ? 'bg-text/5' : ''}`}><td className="max-w-0 py-2"><button className="block max-w-full truncate text-left font-medium hover:underline" title={row.name} aria-expanded={row.pid === selectedPid} onClick={() => setSelectedPid(row.pid === selectedPid ? null : row.pid)}>{row.name}</button><div className="truncate text-caption text-text-dim" title={`${row.user} · ${row.state}`}>{row.pid} · {row.user} · {row.state}</div></td><td className="whitespace-nowrap px-2 text-right tabular-nums">{percentage(row.cpu)}</td><td className="whitespace-nowrap text-right tabular-nums">{bytes(row.memory)}</td></tr>)}</tbody></table></div>
      {!rows.length && <p className="text-body text-text-dim">{m.noProcesses}</p>}
    </div>;
  }}</MetricSection>;
  if (s.serviceManager === 'unsupported') return null;
  return <MetricSection metric={s.services}>{services => <div className="grid gap-3 @xl:grid-cols-2">
    {!services.length && <p className="text-body text-text-dim">{m.noServices}</p>}
    {services.map(service => <div key={service.unit} className={`${box} space-y-3`}>
      <div className="flex items-start gap-2"><Glyph icon={Cog6ToothIcon} label={service.description || m.services} className="text-text-dim" /><p title={service.description} className="min-w-0 break-all text-caption font-medium">{service.unit}</p></div>
      <div className="flex flex-wrap items-center gap-2 text-caption"><Glyph icon={service.active === 'active' ? CheckIcon : service.active === 'failed' ? ExclamationTriangleIcon : StopIcon} label={serviceState(service)} /><span title={`${service.active} · ${service.sub}`}>{serviceState(service)}</span><span className="ml-auto text-text-dim" title={m.bootService}>{service.enabled}</span></div>
      <div className="grid grid-cols-2 gap-3"><Stat icon={HashtagIcon} label="PID">{service.pid ?? '—'}</Stat><Stat icon={CircleStackIcon} label={m.memory}>{bytes(service.memory)}</Stat><Stat icon={ClockIcon} label={m.cpuTime}>{service.cpuSeconds == null ? '—' : `${service.cpuSeconds.toFixed(1)}s`}</Stat><Stat icon={PlayIcon} label={m.uptime}>{service.uptime == null ? '—' : uptime(service.uptime)}</Stat><Stat icon={ArrowPathIcon} label={m.restarts}>{service.restarts ?? '—'}</Stat><Stat icon={QueueListIcon} label={m.tasks}>{service.tasks ?? '—'}</Stat></div>
      {service.result && !['success', 'unknown'].includes(service.result) && <Stat icon={ExclamationTriangleIcon} label={m.result}>{service.result}</Stat>}
    </div>)}
  </div>}</MetricSection>;
}

export default function ServerMonitorView({ active, target }: { active: boolean; target?: MonitorTarget }) {
  const m = t.serverMonitor;
  const { detail: snapshot, failed: error } = useServerMonitor('detail', active);
  const [tab, setTab] = useState<Tab>(target?.tab ?? 'overview'), [history, setHistory] = useState<History>(emptyHistory);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [saving, setSaving] = useState(false), [saveMessage, setSaveMessage] = useState('');
  /* 服务名规则两边不同——systemd 要 .service 后缀，launchd 的标签不要——所以提示和
     占位符得跟着这台机器实际用的那套走。不支持时编辑框本来也没意义，随便退回一个。 */
  const manager = snapshot && snapshot.serviceManager !== 'unsupported' ? snapshot.serviceManager : 'systemd';
  const saveAbort = useRef<AbortController | null>(null);
  const { expanded, setExpanded, dialog, sideSlot, modalSlot, expandButton, contentHost } = useLibraryPresentation(active);
  useEffect(() => { if (target) setTab(target.tab); }, [target]);
  useEffect(() => { if (active && snapshot) setHistory(previous => sampleHistory(previous, snapshot)); }, [active, snapshot]);
  useEffect(() => () => saveAbort.current?.abort(), []);
  const save = async () => {
    const units = draft.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    if (units.length > 24 || units.some(s => s.length > 180 || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(s))) { setSaveMessage(m.serviceInvalid); return; }
    const controller = new AbortController(); saveAbort.current = controller; setSaving(true); setSaveMessage('');
    const timeout = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), 12000);
    try { await saveMonitoredServices(units, controller.signal); if (controller.signal.aborted) return; setEditing(false); setSaveMessage(m.serviceSaved); refreshServerMonitor(); }
    catch { if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') setSaveMessage(m.serviceFailed); }
    finally { clearTimeout(timeout); if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') setSaving(false); }
  };
  const content = <div className="server-monitor flex min-h-0 flex-1 flex-col text-text">
    <div className="flex shrink-0 items-center gap-1 border-b border-border/60 p-2"><span title={m.refreshHint} aria-label={m.refreshHint} className="mr-auto flex items-center gap-1.5 px-1 text-caption tabular-nums text-text-dim"><span className={`size-1.5 rounded-full ${error ? 'rounded-none border border-text' : snapshot ? 'bg-text' : 'border border-text-dim'}`} />5s</span><button className={button} title={m.refresh} aria-label={m.refresh} onClick={() => refreshServerMonitor()}><ArrowPathIcon className="size-3.5" /></button>{!expanded && <button ref={expandButton} className={button} title={m.expand} aria-label={m.expand} onClick={() => setExpanded(true)}><ArrowsPointingOutIcon className="size-3.5" /></button>}</div>
    <nav aria-label={m.title} className="flex shrink-0 gap-1 border-b border-border/60 p-2">{tabs.map(({ id, icon: Icon }) => <button key={id} type="button" title={m[id]} aria-label={m[id]} aria-pressed={tab === id} onClick={() => setTab(id)} className={`flex min-w-0 flex-1 justify-center rounded-md py-2 transition-colors ${tab === id ? 'bg-text text-bg-panel' : 'text-text-dim hover:bg-bg-hover hover:text-text'}`}><Icon className="size-4" aria-hidden="true" /></button>)}</nav>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 @container">
      {error && <div role="status" className="mb-3 flex items-center gap-2 text-body text-text"><span>{m.failed}</span><button className={button} onClick={() => refreshServerMonitor()}>{m.retry}</button></div>}
      {!snapshot && !error && <p role="status" className="text-body text-text-dim">{m.loading}</p>}
      {snapshot && tab === 'services' && <div className="mb-3 space-y-3">{snapshot.serviceManager === 'unsupported' && <p className="text-body text-text-dim">{m.noServiceManager}</p>}{!editing ? <button className={button} title={m.editServices} aria-label={m.editServices} onClick={() => { setDraft(snapshot.configuredServices.join('\n')); setEditing(true); setSaveMessage(''); }}><Cog6ToothIcon className="size-4" /></button> : <div className={box}><p className="mb-2 text-caption leading-relaxed text-text-dim">{m.serviceHint[manager]}</p><textarea aria-label={m.editServices} placeholder={m.servicePlaceholder[manager]} rows={6} value={draft} onChange={e => setDraft(e.target.value)} disabled={saving} className="w-full resize-y rounded-md border border-border bg-bg p-2 font-mono text-body" /><div className="mt-2 flex gap-2"><button className={button} title={saving ? m.saving : m.save} aria-label={saving ? m.saving : m.save} disabled={saving} onClick={() => void save()}>{saving ? <ArrowPathIcon className="size-4 animate-spin" /> : <CheckIcon className="size-4" />}</button><button className={button} title={m.cancel} aria-label={m.cancel} disabled={saving} onClick={() => { setEditing(false); setSaveMessage(''); }}><XMarkIcon className="size-4" /></button></div></div>}{saveMessage && <p role="status" className="text-body text-text-dim">{saveMessage}</p>}</div>}
      {snapshot && <Details snapshot={snapshot} tab={tab} history={history} onTab={setTab} />}
      {snapshot && <p className="mt-4 text-caption text-text-dim">{new Date(snapshot.timestamp).toLocaleTimeString()}</p>}
    </div>
  </div>;
  return <><div ref={sideSlot} className="flex min-h-0 flex-1 flex-col" /><dialog ref={dialog} aria-label={m.title} onCancel={e => { e.preventDefault(); setExpanded(false); }} onClose={() => setExpanded(false)} className="server-monitor m-auto h-[86dvh] max-h-[960px] w-[94vw] max-w-[1080px] overflow-hidden rounded-xl border border-border bg-bg-panel p-0 text-text shadow-modal backdrop:bg-black/55"><div className="flex h-full min-h-0 flex-col"><header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4"><h2 className="text-title font-semibold">{m.title}{snapshot ? ` · ${snapshot.host.hostname}` : ''}</h2><button className={button} aria-label={m.collapse} onClick={() => setExpanded(false)}><XMarkIcon className="size-4" /></button></header><div ref={modalSlot} className="flex min-h-0 flex-1 flex-col" /></div></dialog>{createPortal(content, contentHost)}</>;
}
