/*
  启动台：本机在跑的服务，点一下就打开，不用记端口。

  **默认动作是新标签页，不是浮动窗口。** 理由写在 `AppFrame` 顶上：被代理的应用和 roost
  同源，同源 iframe 不是安全边界。标签页对**每一个**应用都有效，包括那些设了
  `X-Frame-Options` 根本不让被框的（Jupyter 就是）。窗口是第二个动作，按应用自己选。
*/
import { useCallback, useEffect, useState } from 'react';
import { t } from '@roost/i18n';
import { useWorkspace } from '../../shared/store';
import { fetchListeningPorts, type PortsReport } from '../../shared/api/serverMonitor';
import { openWindow } from '../windows/store';
import { appUrl, launchApps, type LaunchApp } from './apps';

export function Launchpad() {
  const m = t.misc.launchpad;
  const { sessions } = useWorkspace('sessions');
  const [report, setReport] = useState<PortsReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    // `probe=1`：多问一次每个端口说的是不是 HTTP，否则 postgres 也会被画成应用。
    fetchListeningPorts(controller.signal, { probe: true })
      .then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [revision]);

  const titleOf = useCallback((id: string) => sessions.find(session => session.id === id)?.title, [sessions]);

  if (failed) return <Shell><p className="text-caption text-danger">{m.failed}</p></Shell>;
  if (!report) return <Shell><p className="text-caption text-text-dim">{m.loading}</p></Shell>;
  // 「看不到」和「一个都没有」分开说；混同它们是在撒谎，端口面板那一侧也是这么处理的。
  if (!report.supported) return <Shell><p className="text-caption text-text-dim">{m.unsupported}</p></Shell>;
  const apps = launchApps(report.services, titleOf);
  if (!apps.length) return <Shell onRefresh={() => setRevision(value => value + 1)}><p className="text-caption text-text-dim">{m.empty}</p></Shell>;

  return (
    <Shell onRefresh={() => setRevision(value => value + 1)}>
      <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
        {apps.map(app => <AppCard key={`${app.pid}:${app.port}`} app={app} />)}
      </ul>
    </Shell>
  );
}

function Shell({ children, onRefresh }: { children: React.ReactNode; onRefresh?: () => void }) {
  const m = t.misc.launchpad;
  return (
    <section className="flex min-h-0 flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-body font-semibold text-text">{m.title}</h2>
        <span className="min-w-0 flex-1 truncate text-caption text-text-dim">{m.hint}</span>
        {onRefresh && <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-caption text-text-dim hover:bg-bg-hover hover:text-text"
          onClick={onRefresh}>{m.refresh}</button>}
      </div>
      {children}
    </section>
  );
}

function AppCard({ app }: { app: LaunchApp }) {
  const m = t.misc.launchpad;
  return (
    <li className="group relative rounded-lg border border-border bg-bg-panel transition-colors hover:border-text-dim">
      {/*
        整张卡片就是那个链接——目标大、能中键打开、能右键复制地址，这些都是 `<a>` 免费带的，
        换成 onClick 的 div 就全没了。
      */}
      <a href={appUrl(app.port)} target="_blank" rel="noreferrer" className="flex flex-col gap-0.5 p-2.5">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate text-body font-medium text-text">{app.name}</span>
          <span className="shrink-0 font-mono text-caption tabular-nums text-text-dim">:{app.port}</span>
        </span>
        <span className="truncate text-caption text-text-dim">{app.detail ?? ' '}</span>
        {app.alsoOn.length > 0 && (
          <span className="truncate text-caption text-text-dim/60">{m.alsoOn(app.alsoOn.map(port => `:${port}`).join(' '))}</span>
        )}
      </a>
      {/*
        第二个动作只在悬停/聚焦时出现：默认路径要单一，多一个并排的按钮会让人每次都得选。
        `focus-within` 那一份是给键盘的——只挂 hover 的话按 Tab 过来看不见它。
      */}
      <button type="button" title={m.windowWarning}
        className="absolute right-1.5 top-1.5 rounded bg-bg-raised px-1.5 py-0.5 text-caption text-text-dim opacity-0 transition-opacity hover:text-text group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
        onClick={() => openWindow({ kind: 'app', port: app.port, name: app.name })}>{m.openWindow}</button>
    </li>
  );
}
