import { CommandLineIcon, Cog6ToothIcon, BookmarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { BookmarksDialog } from "../features/bookmarks/BookmarksDialog";
import { t } from "@roost/i18n";

export function LeftRail({
  collapsed,
  onToggle,
  onSettings,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onSettings: () => void;
}) {
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  return (
    <nav
      className="bar-chrome flex w-10 shrink-0 flex-col items-center gap-1 bg-bar py-2"
      aria-label={t.misc.leftRail.view}
    >
      <button
        className={`grid h-9 w-9 place-items-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text ${
          collapsed
            ? "text-bar-dim hover:bg-bar-text/10 hover:text-bar-text"
            : "bg-bar-text text-bar"
        }`}
        title={collapsed ? t.misc.leftRail.expandSessions : t.misc.leftRail.collapseSessions}
        type="button"
        aria-label={t.misc.leftRail.sessions}
        aria-pressed={!collapsed}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <CommandLineIcon className="size-5" />
      </button>
      <button type="button" aria-label={t.bookmarks.open} title={t.bookmarks.title} aria-haspopup="dialog" onClick={() => setBookmarksOpen(true)} className="grid h-9 w-9 place-items-center rounded-lg text-bar-dim transition-colors hover:bg-bar-text/10 hover:text-bar-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text"><BookmarkIcon className="size-5" /></button>
      {bookmarksOpen && <BookmarksDialog onClose={() => setBookmarksOpen(false)} />}
      <button type="button" aria-label={t.misc.leftRail.settings} title={t.misc.leftRail.settingsTitle} aria-haspopup="dialog" onClick={onSettings}
        className="mt-auto grid h-9 w-9 place-items-center rounded-lg text-bar-dim transition-colors hover:bg-bar-text/10 hover:text-bar-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text">
        <Cog6ToothIcon className="size-5" />
      </button>
    </nav>
  );
}
