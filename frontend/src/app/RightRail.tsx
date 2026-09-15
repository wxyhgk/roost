import { CodeBracketIcon, CommandLineIcon, FolderIcon, DocumentTextIcon, ServerIcon } from "@heroicons/react/24/outline";
import type { RightView } from "../shared/view";
import { t } from "@roost/i18n";

export function RightRail({
  view,
  collapsed,
  withTerminal,
  onSelect,
}: {
  view: RightView;
  collapsed: boolean;
  /**
   * 右栏这一档能不能装终端。**只有对话模式给 true**：那时终端住在右栏，
   * 而终端模式下终端已经占着中栏，右栏再来一个是同一份东西的两处。
   */
  withTerminal: boolean;
  onSelect: (view: RightView) => void;
}) {
  // 每次渲染重取：切换语言后标题要跟着变，不能缓存在模块顶层。
  const items = [
    // 终端排在最前：对话模式下它是这条轨的默认档，也是最常点回去的那一个。
    ...(withTerminal ? [{ id: "terminal" as const, title: t.misc.rightRail.titles.terminal, Icon: CommandLineIcon }] : []),
    { id: "files" as const, title: t.misc.rightRail.titles.files, Icon: FolderIcon },
    { id: "notes" as const, title: t.misc.rightRail.titles.notes, Icon: DocumentTextIcon, ServerIcon },
    { id: "snippets" as const, title: t.misc.rightRail.titles.snippets, Icon: CodeBracketIcon },
    { id: "server" as const, title: t.serverMonitor.title, Icon: ServerIcon },
  ];
  return (
    <nav
      className="bar-chrome flex w-10 shrink-0 flex-col items-center gap-1 bg-bar py-2"
      aria-label={t.misc.rightRail.view}
    >
      {items.map(({ id, title, Icon }) => (
        <button
          key={id}
          type="button"
          className={`grid h-9 w-9 place-items-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text ${
            !collapsed && view === id
              ? "bg-bar-text text-bar"
              : "text-bar-dim hover:bg-bar-text/10 hover:text-bar-text"
          }`}
          title={title}
          aria-label={title}
          aria-pressed={!collapsed && view === id}
          onClick={() => onSelect(id)}
        >
          <Icon className="size-5" />
        </button>
      ))}
    </nav>
  );
}
