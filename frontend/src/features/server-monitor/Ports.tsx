/*
  哪个端口上跑着什么。

  **这是整机视角，不是「这条终端起了什么」**——那个在终端面板里另有一份，按 tty 过滤。
  人想知道「8080 是谁占着」的时候，往往正因为那玩意不是从当前终端起的：上周起的、
  或者被 launchd 拉起来的。

  点开才取，不跟着监控那条轮询走：服务端要 fork 一次 lsof。
*/
import { useEffect, useState, type ReactNode } from 'react';
import { t } from '@roost/i18n';
import { fetchListeningPorts, type ListeningService, type PortsReport } from '../../shared/api/serverMonitor';
import { useWorkspace } from '../../shared/store';
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

export function Ports() {
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
