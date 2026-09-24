/*
  启动台：本机跑着什么，点一下就开，不用记端口。

  **默认动作是新标签页，不是浮动窗口。** 理由写在 `AppFrame` 顶上：被代理的应用和 roost
  同源，同源 iframe 不是安全边界。标签页对**每一个**应用都有效，包括那些设了
  `X-Frame-Options` 根本不让被框的（Jupyter 就是）。窗口是第二个动作，按应用自己选。

  固定区在上、其余在下。两段的差别不只是位置：**固定区按用户拖出来的顺序，其余按自动
  规则排**，而且固定住的应用没在跑时仍然占着位置。理由都在 `apps.ts` 的 `arrangeApps`。
*/
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { t } from '@roost/i18n';
import { useWorkspace } from '../../shared/store';
import { fetchListeningPorts, type PortsReport } from '../../shared/api/serverMonitor';
import { openWindow } from '../windows/store';
import { appUrl, arrangeApps, isOffline, launchApps, reorderPins, togglePin,
  type LaunchApp, type OfflineApp } from './apps';

export function Launchpad() {
  const m = t.misc.launchpad;
  const { sessions, pinnedAppPorts, setPinnedAppPorts } = useWorkspace('sessions', 'pinnedAppPorts', 'setPinnedAppPorts');
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
  /*
    指针传感器给一个 6px 的启动距离：卡片本身是个链接，没有这段距离的话每一次点击都会
    先被当成一次零位移的拖动，链接就点不开了。键盘传感器是另一条路——拖拽在键盘上够不着。
  */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    setPinnedAppPorts(reorderPins(pinnedAppPorts, Number(event.active.id), Number(event.over.id)));
  };

  if (failed) return <Frame><p className="text-caption text-danger">{m.failed}</p></Frame>;
  if (!report) return <Frame><p className="text-caption text-text-dim">{m.loading}</p></Frame>;
  // 「看不到」和「一个都没有」分开说；混同它们是在撒谎，端口面板那一侧也是这么处理的。
  if (!report.supported) return <Frame><p className="text-caption text-text-dim">{m.unsupported}</p></Frame>;

  const { pinned, rest } = arrangeApps(launchApps(report.services, titleOf), pinnedAppPorts);
  const refresh = () => setRevision(value => value + 1);
  if (!pinned.length && !rest.length) return <Frame onRefresh={refresh}><p className="text-caption text-text-dim">{m.empty}</p></Frame>;

  const pin = (port: number) => setPinnedAppPorts(togglePin(pinnedAppPorts, port));
  return (
    <Frame onRefresh={refresh}>
      {pinned.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={pinned.map(app => app.port)} strategy={rectSortingStrategy}>
            <Grid label={m.pinned}>
              {pinned.map(app => <SortableCard key={app.port} app={app} onUnpin={() => pin(app.port)} />)}
            </Grid>
          </SortableContext>
        </DndContext>
      )}
      {rest.length > 0 && (
        <Grid label={pinned.length > 0 ? m.others : undefined}>
          {rest.map(app => (
            <li key={`${app.pid}:${app.port}`}><AppCard app={app} pinned={false} onPin={() => pin(app.port)} /></li>
          ))}
        </Grid>
      )}
    </Frame>
  );
}

function Frame({ children, onRefresh }: { children: ReactNode; onRefresh?: () => void }) {
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

function Grid({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <>
      {label && <h3 className="text-caption font-medium text-text-dim/70">{label}</h3>}
      <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">{children}</ul>
    </>
  );
}

function SortableCard({ app, onUnpin }: { app: LaunchApp | OfflineApp; onUnpin: () => void }) {
  const sortable = useSortable({ id: app.port });
  return (
    <li ref={sortable.setNodeRef} {...sortable.attributes} {...sortable.listeners}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition,
        // 被拖的那张留在原位但变淡，指示落点的是其余卡片的位移——网格里挪走一张会让整排跳动。
        opacity: sortable.isDragging ? 0.4 : 1 }}
      className="cursor-grab active:cursor-grabbing">
      <AppCard app={app} pinned onPin={onUnpin} />
    </li>
  );
}

function AppCard({ app, pinned, onPin }: { app: LaunchApp | OfflineApp; pinned: boolean; onPin: () => void }) {
  const m = t.misc.launchpad;
  const shell = 'group relative flex h-full flex-col gap-0.5 rounded-lg border p-2.5 transition-colors';
  const actions = (
    <span className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      {!isOffline(app) && (
        <button type="button" title={m.windowWarning} className="rounded bg-bg-raised px-1.5 py-0.5 text-caption text-text-dim hover:text-text"
          onClick={() => openWindow({ kind: 'app', port: app.port, name: app.name })}>{m.openWindow}</button>
      )}
      <button type="button" title={pinned ? m.unpin : m.pin} className="rounded bg-bg-raised px-1.5 py-0.5 text-caption text-text-dim hover:text-text"
        onClick={onPin}>{pinned ? m.unpin : m.pin}</button>
    </span>
  );
  /*
    没在跑的固定项：画出来，但不是链接。

    **点了没反应比一张灰卡片更糟**——人会以为是 roost 坏了。灰着并写明「未运行」是诚实的，
    而且位置留着正是固定这件事的价值所在。
  */
  if (isOffline(app)) {
    return (
      <div className={`${shell} border-dashed border-border/60 bg-transparent text-text-dim`}>
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-body">:{app.port}</span>
        </span>
        <span className="truncate text-caption">{m.notRunning}</span>
        {actions}
      </div>
    );
  }
  return (
    <div className={`${shell} border-border bg-bg-panel hover:border-text-dim`}>
      {/*
        整张卡片就是那个链接——目标大、能中键打开、能右键复制地址，这些都是 `<a>` 免费带的，
        换成 onClick 的 div 就全没了。固定区里它同时是拖拽把手，靠传感器那 6px 的启动
        距离把「点」和「拖」分开。
      */}
      <a href={appUrl(app.port)} target="_blank" rel="noreferrer" className="flex flex-col gap-0.5">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate text-body font-medium text-text">{app.name}</span>
          <span className="shrink-0 font-mono text-caption tabular-nums text-text-dim">:{app.port}</span>
        </span>
        <span className="truncate text-caption text-text-dim">{app.detail ?? ' '}</span>
        {app.alsoOn.length > 0 && (
          <span className="truncate text-caption text-text-dim/60">{m.alsoOn(app.alsoOn.map(port => `:${port}`).join(' '))}</span>
        )}
      </a>
      {actions}
    </div>
  );
}
