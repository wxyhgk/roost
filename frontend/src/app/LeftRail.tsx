import { CommandLineIcon, Cog6ToothIcon, BookmarkIcon, ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { Suspense, lazy, useState } from "react";
/*
  书签对话框本来就是点开才出现的，没道理进首屏。

  而且它是对话视图能否真正拆出去的**另一半**：BookmarksDialog 静态 import
  ConversationDetail，只要这条链还在，那边的 lazy() 就不起作用。见 TerminalLens.tsx。
*/
const BookmarksDialog = lazy(() => import("../features/bookmarks/BookmarksDialog").then(m => ({ default: m.BookmarksDialog })));
/*
  **历史对话目录原来没有任何入口。** 组件本身是完整的（搜索、分页、点进详情、
  详情里还有「把这条对话跑起来」），但全仓库没有一处 import 它——等于做完了锁在抽屉里。

  这件事的后果不只是少一个面板：终端上那个 × 走的是删除，删完之后**对话目录是唯一的
  回家路**（对话本身不会跟着终端一起删）。入口缺失，那条路就等于不存在。
*/
const ConversationCatalog = lazy(() => import("../features/conversations/ConversationCatalog").then(m => ({ default: m.ConversationCatalog })));
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
  const [catalogOpen, setCatalogOpen] = useState(false);
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
      {bookmarksOpen && <Suspense fallback={null}><BookmarksDialog onClose={() => setBookmarksOpen(false)} /></Suspense>}
      <button type="button" aria-label={t.misc.conversations.catalogTitle} title={t.misc.conversations.catalogTitle} aria-haspopup="dialog" onClick={() => setCatalogOpen(true)} className="grid h-9 w-9 place-items-center rounded-lg text-bar-dim transition-colors hover:bg-bar-text/10 hover:text-bar-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text"><ChatBubbleLeftRightIcon className="size-5" /></button>
      {catalogOpen && <Suspense fallback={null}><ConversationCatalog onClose={() => setCatalogOpen(false)} /></Suspense>}
      <button type="button" aria-label={t.misc.leftRail.settings} title={t.misc.leftRail.settingsTitle} aria-haspopup="dialog" onClick={onSettings}
        className="mt-auto grid h-9 w-9 place-items-center rounded-lg text-bar-dim transition-colors hover:bg-bar-text/10 hover:text-bar-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text">
        <Cog6ToothIcon className="size-5" />
      </button>
    </nav>
  );
}
