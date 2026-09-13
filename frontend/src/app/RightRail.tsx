import { CodeBracketIcon, FolderIcon, DocumentTextIcon, ServerIcon } from "@heroicons/react/24/outline";
import type { RightView } from "./RightPanel";
import { t } from "@roost/i18n";

export function RightRail({
  view,
  collapsed,
  onSelect,
}: {
  view: RightView;
  collapsed: boolean;
  onSelect: (view: RightView) => void;
}) {
  // 每次渲染重取：切换语言后标题要跟着变，不能缓存在模块顶层。
  const items = [
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
