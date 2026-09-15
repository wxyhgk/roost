import { CommandLineIcon, Cog6ToothIcon, BookmarkIcon, ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { Suspense, lazy, useState, type ReactNode } from "react";
/*
  书签对话框本来就是点开才出现的，没道理进首屏。

  而且它是对话视图能否真正拆出去的**另一半**：BookmarksDialog 静态 import
  ConversationDetail，只要这条链还在，那边的 lazy() 就不起作用。见 TerminalLens.tsx。
*/
const BookmarksDialog = lazy(() => import("../features/bookmarks/BookmarksDialog").then(m => ({ default: m.BookmarksDialog })));
import type { Workbench } from "../shared/view";
import { t } from "@roost/i18n";

export function LeftRail({
  collapsed,
  onToggle,
  workbench,
  onWorkbench,
  onSettings,
  inbox,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /**
   * 顶层模式。两颗按钮各自负责一种，**点当前那颗等于收起左栏**。
   *
   * 它切的是整套三栏（见 `shared/view.ts` 的 `Workbench`），不再只是左栏的内容；
   * 收起左栏之后这两颗仍然亮着当前模式，因为模式和左栏开没开是两件事。
   */
  workbench: Workbench;
  onWorkbench: (workbench: Workbench) => void;
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
      {/*
        两颗按钮，两种模式。**点当前这颗等于收起左栏**——和原来那颗单独的开关是
        同一个手势，只是现在有两个目的地。收着的时候点任意一颗都是「展开并切到它」。

        `aria-pressed` 跟的是「左栏展开着并且停在这一档」，不是「模式是不是这一档」：
        收起状态下两颗都不高亮，否则轨上会有一颗按钮亮着、旁边却什么都没有。
      */}
      {([
        ["conversation", ChatBubbleLeftRightIcon, t.misc.leftRail.conversations, t.misc.leftRail.conversationsTitle],
        ["terminal", CommandLineIcon, t.misc.leftRail.terminal, t.misc.leftRail.terminalTitle],
      ] as const).map(([value, Icon, label, title]) => {
        const active = !collapsed && workbench === value;
        return (
          <button
            key={value}
            className={`grid h-9 w-9 place-items-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text ${
              active ? "bg-bar-text text-bar" : "text-bar-dim hover:bg-bar-text/10 hover:text-bar-text"
            }`}
            title={title}
            type="button"
            aria-label={label}
            aria-pressed={active}
            aria-expanded={active}
            onClick={() => { if (active) { onToggle(); return; } onWorkbench(value); if (collapsed) onToggle(); }}
          >
            <Icon className="size-5" />
          </button>
        );
      })}
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
