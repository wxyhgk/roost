import { useEffect, useState } from "react";
import { IconFolder, IconTerminal } from "../../shared/icons";
import { isOpen, useWorkspace } from "../../shared/store";
import { NewSessionButtons, WorkspaceRow } from "./WorkspaceRow";
import { NoticeBar } from "../../shared/ui/NoticeBar";
import { PanelHeader } from "../../shared/ui/PanelHeader";
import type { Scope } from "../../shared/view";
import { t } from "@roost/i18n";

const EXPANDED_KEY = "roost-workspace-expanded-v1";
function loadExpanded(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/**
 * 侧栏：一列工作区，不再是一列会话。
 *
 * 会话本身现在是中间画布上的卡片。侧栏再列一遍就是同一件事讲两遍——那正是之前
 * 界面「很乱」的来源。这里只回答「有哪些工作区、各有几个终端、哪个在等你」。
 */
export function Sidebar({ scope, onScope, onEnterTerminal }: {
  scope: Scope;
  onScope: (scope: Scope) => void;
  /** 从侧栏点开一个终端时切到终端视图，别停在画布上。 */
  onEnterTerminal: () => void;
}) {
  const { projects, sessions: allSessions, error, deleteProject, renameProject, selectSession, selectedId } =
    useWorkspace("projects", "sessions", "error", "deleteProject", "renameProject", "selectSession", "selectedId");
  const sessions = allSessions.filter(isOpen);
  const sessionsIn = (projectId: string | null) => sessions.filter(s => s.projectId === projectId);

  /*
    哪些工作区展开着。存本地：它是「我这会儿想看到什么」，而且「全部」「未分组」
    这两行不是真的分组，塞不进服务端那个 expandedProjectIds（那个字段存的是分组
    ID，混进哨兵值迟早出事）。所以整套展开状态都留在本地，一种机制。
  */
  const [expanded, setExpanded] = useState<string[]>(loadExpanded);
  useEffect(() => {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded)); } catch { /* 存不了就下次全收起 */ }
  }, [expanded]);
  const toggle = (key: string) =>
    setExpanded(now => now.includes(key) ? now.filter(x => x !== key) : [...now, key]);

  /*
    当前终端所在的工作区自动展开——侧栏要回答的正是「我在哪」，收着就答不了。
    只在收着的时候展开一次，之后你手动收起它就保持收起，不跟你抢。
  */
  const currentKey = (() => {
    const current = sessions.find(s => s.id === selectedId);
    if (!current) return null;
    // 「全部终端」不展开，所以没有分组时也归到「未分组」那一行去。
    return current.projectId ?? "ungrouped";
  })();
  useEffect(() => {
    if (currentKey && !expanded.includes(currentKey)) setExpanded(now => [...now, currentKey]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  function openSession(id: string) {
    selectSession(id);
    onEnterTerminal();
  }

  return (
    /*
      三段：顶栏「全部终端」钉住、工作区列表滚动、底栏「新建工作区」钉住。

      钉住那两条是因为它们**不属于列表**：一个是「不筛」这个视角，一个是新增入口。
      跟着一起滚的话，工作区一多，最常点的两样反而要先滚回去找。
    */
    <aside className="flex h-full min-h-0 flex-col bg-bg-panel">
      <PanelHeader title={t.sidebar.title} sub={t.sidebar.count(sessions.length)} />
      {error && <NoticeBar tone="error">{error}</NoticeBar>}

      <div className="shrink-0 border-b border-border p-2">
        {/*
          「全部终端」不展开：画布本来就在显示全部，侧栏再列一遍是同一份内容讲两遍；
          而且它钉在这条 bar 里，展开会把 bar 撑没边。点它只是把画布切回不筛。
        */}
        <WorkspaceRow
          id={null}
          name={t.sidebar.allTerminals}
          icon={<IconTerminal />}
          sessions={sessions}
          selected={scope === "all"}
          expandable={false}
          showCount={false}
          expanded={false}
          onToggle={() => {}}
          onSelect={() => onScope("all")}
          onOpenSession={openSession}
          currentSessionId={selectedId}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2">
        {projects.map(project => (
          <WorkspaceRow
            key={project.id}
            id={`project:${project.id}`}
            name={project.name}
            icon={<IconFolder />}
            sessions={sessionsIn(project.id)}
            selected={scope === project.id}
            expanded={expanded.includes(project.id)}
            onToggle={() => toggle(project.id)}
            onSelect={() => onScope(project.id)}
            onOpenSession={openSession}
            currentSessionId={selectedId}
            onRename={name => renameProject(project.id, name)}
            onDelete={() => {
              if (!window.confirm(t.project.deleteConfirm(project.name))) return;
              deleteProject(project.id);
              // 删掉的正是当前范围时退回「全部」，否则画布会停在一个不存在的工作区上。
              if (scope === project.id) onScope("all");
            }}
          />
        ))}

        {/*
          「未分组」在两种情况下都要在：有分组时它是「不属于任何一个」的去处和拖拽落点；
          一个分组都没有时它是**唯一**列着终端的地方——顶栏那个「全部终端」不展开，
          少了这一行，新装的人在侧栏里根本看不见自己的终端。
        */}
        {(projects.length > 0 || sessionsIn(null).length > 0) && (
          <WorkspaceRow
            id="ungrouped"
            name={t.sidebar.ungrouped}
            icon={<IconFolder />}
            sessions={sessionsIn(null)}
            selected={scope === null}
            expanded={expanded.includes("ungrouped")}
            onToggle={() => toggle("ungrouped")}
            onSelect={() => onScope(null)}
            onOpenSession={openSession}
            currentSessionId={selectedId}
          />
        )}

        {sessions.length === 0 && projects.length === 0 && (
          <div className="px-2.5 py-3 text-body leading-[1.45] text-text-dim">{t.sidebar.empty}</div>
        )}
        {sessions.length > 0 && projects.length > 0 && (
          <div className="mt-auto px-2.5 pt-3 text-caption leading-[1.45] text-text-dim/80">
            {t.sidebar.dragHint}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <NewSessionButtons scope={scope} />
      </div>
    </aside>
  );
}
