import { CommandLineIcon, Cog6ToothIcon, BookmarkIcon } from "@heroicons/react/24/outline";
import { Suspense, lazy, useState, type ReactNode } from "react";
/*
  书签对话框本来就是点开才出现的，没道理进首屏。

  而且它是对话视图能否真正拆出去的**另一半**：BookmarksDialog 静态 import
  ConversationDetail，只要这条链还在，那边的 lazy() 就不起作用。见 TerminalLens.tsx。
*/
const BookmarksDialog = lazy(() => import("../features/bookmarks/BookmarksDialog").then(m => ({ default: m.BookmarksDialog })));
import { t } from "@roost/i18n";

export function LeftRail({
  collapsed,
  onToggle,
  onSettings,
  inbox,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onSettings: () => void;
  /** 「有几个会话在等你」那个角标。一个都没有时它自己不渲染，所以这里不必判空。 */
  inbox?: ReactNode;
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
      {inbox}
      <button type="button" aria-label={t.bookmarks.open} title={t.bookmarks.title} aria-haspopup="dialog" onClick={() => setBookmarksOpen(true)} className="grid h-9 w-9 place-items-center rounded-lg text-bar-dim transition-colors hover:bg-bar-text/10 hover:text-bar-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text"><BookmarkIcon className="size-5" /></button>
      {bookmarksOpen && <Suspense fallback={null}><BookmarksDialog onClose={() => setBookmarksOpen(false)} /></Suspense>}
      <button type="button" aria-label={t.misc.leftRail.settings} title={t.misc.leftRail.settingsTitle} aria-haspopup="dialog" onClick={onSettings}
        className="mt-auto grid h-9 w-9 place-items-center rounded-lg text-bar-dim transition-colors hover:bg-bar-text/10 hover:text-bar-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text">
        <Cog6ToothIcon className="size-5" />
      </button>
    </nav>
  );
}
