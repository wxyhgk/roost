import { sessionTitle } from "../shared/sessionTitle";
import { useWorkspace } from "../shared/store";
import { useTheme } from "../shared/theme";
import { MoonIcon, SunIcon, ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
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
}: {
  /** 新终端落在哪个工作区——和画布上那个「新建终端」保持一致。 */
  scope: Scope;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const { projects, sessions, selectedId } = useWorkspace("projects", "sessions", "selectedId");
  const { renameSession } = useWorkspace("renameSession");
  const [renaming, setRenaming] = useState(false);
  const session = sessions.find((s) => s.id === selectedId) ?? null;
  const project = projects.find((p) => p.id === session?.projectId) ?? null;

  return (
    <header className="bar-chrome flex h-10 shrink-0 items-center gap-2 bg-bar px-2.5">
      <IconButton
        inverse
        className="h-8 w-8"
        title={leftCollapsed ? t.topBar.expandSessions : t.topBar.collapseSessions}
        onClick={onToggleLeft}
      >
        <ChevronLeftIcon className={`size-4 transition-transform ${leftCollapsed ? "rotate-180" : ""}`} />
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
        <NewMenu scope={scope} />
        <IconButton
          inverse
          className="h-8 w-8"
          title={theme === "dark" ? t.topBar.toLightTheme : t.topBar.toDarkTheme}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
        </IconButton>
        <IconButton
          inverse
          className="h-8 w-8"
          title={rightCollapsed ? t.topBar.expandRight : t.topBar.collapseRight}
          onClick={onToggleRight}
        >
          <ChevronRightIcon className={`size-4 transition-transform ${rightCollapsed ? "rotate-180" : ""}`} />
        </IconButton>
      </div>
    </header>
  );
}
