import { CodeBracketIcon, FolderIcon, DocumentTextIcon, ListBulletIcon, ServerIcon, ServerStackIcon } from "@heroicons/react/24/outline";
import type { RightView } from "../shared/view";
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
    // agent 自己列的任务清单。终端里那份会滚走，这一栏不会。
    { id: "tasks" as const, title: t.misc.rightRail.titles.tasks, Icon: ListBulletIcon },
    // 「这个终端里在跑什么」。和服务器监控是两回事：那个说整机，这个说这一条终端。
    { id: "processes" as const, title: t.terminal.processes.title, Icon: ServerStackIcon },
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
