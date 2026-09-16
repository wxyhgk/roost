import { lazy, Suspense } from "react";
import { useLibraryPresentation } from "../shared/ui/useLibraryPresentation";
import { createPortal } from "react-dom";
import { useWorkspace } from "../shared/store";
import type { NotesTab } from "../features/notes/NotesView";
import type { RightView } from "../shared/view";
import { PanelHeader } from "../shared/ui/PanelHeader";
import { IconClose } from "../shared/icons";
import { IconButton } from "../shared/ui/IconButton";
import { t } from "@roost/i18n";

import type { MonitorTarget } from '../features/server-monitor/navigation';

/*
  三个面板都按需加载。

  它们本来就是**条件渲染**的——同一时刻只有一个在屏幕上——但其中两个是静态 import，
  于是整条依赖链都压在首屏：CodeMirror 和它的五种语言模式、整个 shiki 栈、文件图标
  子集、以及 files/notes 两个 feature 的全部代码。实测把这两个换成 lazy 之后，首屏
  从 770 KB 降到约 516 KB（gzip），是这一轮里最大的一笔。

  代价是第一次点开某个面板时要等它的 chunk 落地，期间显示占位；之后模块就在内存里了。
  `ServerMonitorView` 早就是这么做的，这里只是把另外两个对齐。
*/
const ServerMonitorView = lazy(() => import("../features/server-monitor/ServerMonitorView"));
const FilesView = lazy(() => import("../features/files/FilesView").then(m => ({ default: m.FilesView })));
const NotesView = lazy(() => import("../features/notes/NotesView").then(m => ({ default: m.NotesView })));
const TerminalProcesses = lazy(() => import("../features/terminal/view/TerminalProcesses").then(m => ({ default: m.TerminalProcesses })));
export function RightPanel({ view, onChangeView, visible = true, monitorTarget }: { view: RightView; onChangeView: (view: RightView) => void; visible?: boolean; monitorTarget?: MonitorTarget }) {
  // 每次渲染重取：切换语言后标题要跟着变，不能缓存在模块顶层。
  // 同上：占位文案也要每次渲染重取，模块级常量会把语言定死在首次加载那一刻。
  const panelFallback = <p className="p-3 text-xs text-text-dim">{t.misc.rightPanel.loading}</p>;
  /*
    键类型故意写成结构化的那个联合而不是 RightView：它和下面的 `titles[view]` 一起，
    把 shared/view.ts 里的 RightView 和 features/library 的 Kind 钉成同一个集合。
    理由写在 shared/view.ts 的 RightView 上面。
  */
  const titles: Record<"files" | "server" | "processes" | NotesTab, string> = { server: t.serverMonitor.title, processes: t.terminal.processes.title, files: t.misc.rightPanel.titles.files, notes: t.misc.rightPanel.titles.notes, snippets: t.misc.rightPanel.titles.snippets };
  const { sessions, selectedId } = useWorkspace("sessions", "selectedId");
  const session = sessions.find(s => s.id === selectedId && !s.closed);
  // 文件和 AI 两个视图都是终端自己的内容，不走「资料库」那套弹出布局。
  const isLibrary = view === "notes" || view === "snippets";
  const { expanded, setExpanded, dialog, sideSlot, modalSlot, expandButton, contentHost, searchInput } = useLibraryPresentation(isLibrary);

  return <section className={`flex h-full flex-col bg-bg-panel ${view === "server" ? "server-monitor" : ""}`}>
    <PanelHeader title={titles[view]} sub={view === "files" ? session?.cwd : undefined}
      actions={isLibrary && <button ref={expandButton} className="rounded px-2 py-1 text-xs font-normal text-text-dim hover:bg-bg-hover hover:text-text" onClick={() => setExpanded(true)} aria-haspopup="dialog">{t.misc.rightPanel.expandLibrary}</button>} />
    {view === "files" ? <div key="files" className="flex min-h-0 flex-1 flex-col"><Suspense fallback={panelFallback}><FilesView /></Suspense></div>
      : view === "server" ? <Suspense fallback={<p className="p-3 text-xs text-text-dim">{t.serverMonitor.loading}</p>}><ServerMonitorView active={visible} target={monitorTarget} /></Suspense>
      : view === "processes" ? <Suspense fallback={panelFallback}><TerminalProcesses sessionId={session?.id ?? null} active={visible} /></Suspense>
      : <div key="library" ref={sideSlot} className="flex min-h-0 flex-1 flex-col" />}
    <dialog ref={dialog} aria-label={t.misc.rightPanel.library} onCancel={e => { e.preventDefault(); setExpanded(false); }} onClose={() => setExpanded(false)}
      onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && ["k", "b", "j"].includes(e.key.toLowerCase())) e.stopPropagation(); }}
      className="library-dialog m-auto h-[88dvh] max-h-[960px] w-[94vw] max-w-[1440px] overflow-hidden rounded-xl border border-border bg-bg-panel p-0 text-text shadow-modal backdrop:bg-black/55">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-5">
          <h2 className="text-base font-semibold">{t.misc.rightPanel.library}</h2>
          <nav aria-label={t.misc.rightPanel.libraryKind} className="flex gap-1">
            {(["notes", "snippets"] as const).map(kind => <button key={kind} aria-pressed={view === kind} onClick={() => onChangeView(kind)} className={`rounded-md px-3 py-1.5 text-sm ${view === kind ? "bg-bg-active text-text" : "text-text-dim hover:bg-bg-hover"}`}>{titles[kind]}</button>)}
          </nav>
          <span className="ml-auto hidden text-xs text-text-dim sm:inline">{t.misc.rightPanel.hint}</span>
          <IconButton title={t.misc.rightPanel.collapse} onClick={() => setExpanded(false)}><IconClose /></IconButton>
        </header>
        <div ref={modalSlot} className="flex min-h-0 flex-1 flex-col" />
      </div>
    </dialog>
    {isLibrary && createPortal(<Suspense fallback={panelFallback}><NotesView tab={view} expanded={expanded} searchRef={searchInput} /></Suspense>, contentHost)}
  </section>;
}
