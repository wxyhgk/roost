import { useEffect, useState } from "react";
import { isOpen, useWorkspace } from "../../shared/store";
import { sessionTitle } from "../../shared/sessionTitle";
import type { Scope } from "../../shared/view";
import { matchItem } from "./commandSearch";
import { NewWorkspaceButton, WorkspaceRow } from "./WorkspaceRow";
import { WorkspaceSessionRow } from "./WorkspaceSessionRow";
import { SidebarBrowser, SidebarBrowserEmpty } from "../../vendor/dsh/sidebar/WorkspaceBrowser";
import { t } from "@roost/i18n";

const EXPANDED_KEY = "roost-workspace-expanded-v1";
function loadExpanded(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/**
 * 左栏的**列表那一半**：区段头（标题 + 内联展开的搜索 + 「加工作区」）+ 工作区树。
 *
 * 壳是搬来的（`vendor/dsh/sidebar/WorkspaceBrowser`），和对话目录用的是同一个
 * `SidebarBrowser`——这正是这一轮要的：两种模式的左栏在结构和几何上是同一个东西。
 * 照 `features/conversations/ConversationRows.tsx` 的写法来，我们只负责喂数据。
 *
 * **搜索是新的，但不是编出来的**：终端的标题和 cwd 全在内存里，`matchItem`（快速切换
 * 面板那一份模糊匹配，同一个函数）当场就能筛。有词时列表换成**一串扁平的行**，不再分组
 * ——分组是「按工作区归类」，而搜的时候你要的正是跨工作区。上游的搜索结果行
 * （`SearchResultItem`）没搬，它要 snippet；这里复用普通的会话行。
 */
export function WorkspaceRows({ wide, scope, onScope, onOpenSession, onExpandSidebar }: {
  wide: boolean;
  scope: Scope;
  onScope: (scope: Scope) => void;
  /** 点开一个终端：选中它并把中栏切进终端视图。 */
  onOpenSession: (id: string) => void;
  /** 折叠态下点搜索钮：请求把列展开。 */
  onExpandSidebar?: (() => void) | undefined;
}) {
  const { projects, sessions: allSessions, deleteProject, renameProject, selectedId } =
    useWorkspace("projects", "sessions", "deleteProject", "renameProject", "selectedId");
  const sessions = allSessions.filter(isOpen);
  const sessionsIn = (projectId: string | null) => sessions.filter(s => s.projectId === projectId);
  const [query, setQuery] = useState("");

  /*
    哪些工作区展开着。存本地：它是「我这会儿想看到什么」，而且「未分组」这一行不是真的
    分组，塞不进服务端那个 expandedProjectIds（那个字段存的是分组 ID，混进哨兵值迟早出事）。
    所以整套展开状态都留在本地，一种机制。
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
    // 「全部终端」在外面那一格（面板行），不展开，所以没有分组时也归到「未分组」那一行去。
    return current.projectId ?? "ungrouped";
  })();
  useEffect(() => {
    if (currentKey && !expanded.includes(currentKey)) setExpanded(now => [...now, currentKey]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  const q = query.trim();
  const found = q ? sessions.filter(s => matchItem(q, sessionTitle(s), s.cwd) >= 0) : [];

  return (
    <SidebarBrowser
      wide={wide}
      query={query}
      onQueryChange={setQuery}
      flat={q !== ""}
      headerActions={<NewWorkspaceButton wide={wide} />}
      {...(onExpandSidebar ? { onExpandSidebar } : {})}
      labels={{
        section: t.sidebar.title,
        search: t.sidebar.search,
        searchPlaceholder: t.sidebar.search,
        searchClear: t.sidebar.searchClear,
      }}
    >
      {q !== "" ? (
        found.length === 0
          ? <SidebarBrowserEmpty>{t.sidebar.noMatch}</SidebarBrowserEmpty>
          : found.map(item => (
            <WorkspaceSessionRow key={item.id} session={item} current={item.id === selectedId}
              onOpen={() => onOpenSession(item.id)} />
          ))
      ) : (
        <>
          {projects.map(project => (
            <WorkspaceRow
              key={project.id}
              id={`project:${project.id}`}
              name={project.name}
              sessions={sessionsIn(project.id)}
              scoped={scope === project.id}
              expanded={expanded.includes(project.id)}
              onToggle={() => toggle(project.id)}
              onSelect={() => onScope(project.id)}
              onOpenSession={onOpenSession}
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
            一个分组都没有时它是**唯一**列着终端的地方——「全部终端」是面板行、不展开，
            少了这一行，新装的人在侧栏里根本看不见自己的终端。
          */}
          {(projects.length > 0 || sessionsIn(null).length > 0) && (
            <WorkspaceRow
              id="ungrouped"
              name={t.sidebar.ungrouped}
              sessions={sessionsIn(null)}
              scoped={scope === null}
              expanded={expanded.includes("ungrouped")}
              onToggle={() => toggle("ungrouped")}
              onSelect={() => onScope(null)}
              onOpenSession={onOpenSession}
              currentSessionId={selectedId}
            />
          )}

          {sessions.length === 0 && projects.length === 0 && (
            <SidebarBrowserEmpty>{t.sidebar.empty}</SidebarBrowserEmpty>
          )}
          {sessions.length > 0 && projects.length > 0 && (
            <div className="px-2 pt-3 text-caption leading-[1.45] text-text-dim/80">{t.sidebar.dragHint}</div>
          )}
        </>
      )}
    </SidebarBrowser>
  );
}
