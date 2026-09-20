import { sessionTitle } from "../shared/sessionTitle";
import { useWorkspace } from "../shared/store";
import { useTheme } from "../shared/theme";
import { MoonIcon, SunIcon, ChevronLeftIcon, ChevronRightIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { NewMenu } from "../features/workspace/NewMenu";
import type { Scope } from "../shared/view";
import { IconButton } from "../shared/ui/IconButton";
import { InlineRename } from "../shared/ui/InlineRename";
import { useState } from "react";
import { t } from "@roost/i18n";

export function TopBar({
  scope,
  leftCollapsed,
  rightCollapsed,
  onToggleLeft,
  onToggleRight,
  onOpenPalette,
}: {
  /** 新终端落在哪个工作区——和画布上那个「新建终端」保持一致。 */
  scope: Scope;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  /** 快速切换（⌘K）。没有这个入口的话，那个功能在界面上完全不存在。 */
  onOpenPalette: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const { projects, sessions, selectedId } = useWorkspace("projects", "sessions", "selectedId");
  const { renameSession } = useWorkspace("renameSession");
  const [renaming, setRenaming] = useState(false);
  const session = sessions.find((s) => s.id === selectedId) ?? null;
  const project = projects.find((p) => p.id === session?.projectId) ?? null;

  /*
    按钮 36px、图标 20px——和左右两条图标栏对齐。

    顶栏和那两条竖栏是同一层外壳（都吃 `bg-bar`），原来却是 32px 按钮配 16px 图标，
    而竖栏是 36 配 20。同一个表面上两套尺寸，交界处（左上角那个折叠按钮紧挨着左栏第一个
    图标）差 4px 一眼能看出来。
  */
  return (
    <header className="bar-chrome flex h-10 shrink-0 items-center gap-2 bg-bar px-2.5">
      <IconButton
        inverse
        className="h-9 w-9"
        title={leftCollapsed ? t.topBar.expandSessions : t.topBar.collapseSessions}
        onClick={onToggleLeft}
      >
        <ChevronLeftIcon className={`size-5 transition-transform ${leftCollapsed ? "rotate-180" : ""}`} />
      </IconButton>
      <nav className="flex min-w-0 items-center gap-1.5 text-body" aria-label={t.topBar.breadcrumb}>
        {project && (
          <>
            <span className="shrink-0 text-bar-dim">{project.name}</span>
            <span className="shrink-0 text-bar-dim/50">/</span>
          </>
        )}
        {session ? (
          <InlineRename
            className="block min-w-24 cursor-text truncate rounded px-1 font-semibold text-bar-text hover:bg-bar-text/10"
            value={sessionTitle(session)}
            editing={renaming}
            onEditingChange={setRenaming}
            onDisplayClick={() => setRenaming(true)}
            onCommit={(title) => renameSession(session.id, title)}
          />
        ) : <span className="truncate font-semibold text-bar-text">{t.topBar.noSession}</span>}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {/*
          ⌘K 原来只有一个 keydown 监听器，界面上和所有文案里都找不到它——而旁边
          ⌘B / ⌘J / ⌘F / ⌘, 的 tooltip 里都写着自己的快捷键。不知道的人永远不会知道。
        */}
        <IconButton
          inverse
          className="h-9 w-9"
          title={t.topBar.commandPalette}
          onClick={onOpenPalette}
        >
          <MagnifyingGlassIcon className="size-5" />
        </IconButton>
        <NewMenu scope={scope} />
        <IconButton
          inverse
          className="h-9 w-9"
          title={theme === "dark" ? t.topBar.toLightTheme : t.topBar.toDarkTheme}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
        </IconButton>
        <IconButton
          inverse
          className="h-9 w-9"
          title={rightCollapsed ? t.topBar.expandRight : t.topBar.collapseRight}
          onClick={onToggleRight}
        >
          <ChevronRightIcon className={`size-5 transition-transform ${rightCollapsed ? "rotate-180" : ""}`} />
        </IconButton>
      </div>
    </header>
  );
}
