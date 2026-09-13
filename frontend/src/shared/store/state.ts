import type { WorkspaceSnapshot } from "../api";
import type { Session } from "../types";

export type Data = WorkspaceSnapshot & { error: string | null };

export type Action =
  | { type: "hydrate"; data: WorkspaceSnapshot }
  | { type: "addSession"; session: Session }
  | { type: "addProject"; project: WorkspaceSnapshot["projects"][number] }
  | { type: "selectSession"; id: string }
  | { type: "toggleProject"; id: string }
  | { type: "reorderSession"; sessionId: string; projectId: string | null; beforeId: string | null }
  | { type: "togglePin"; id: string }
  | { type: "selectConversation"; id: string | null }
  | { type: "setFollowTerminalConversation"; follow: boolean }
  | { type: "closeSession"; id: string }
  | { type: "killSession"; id: string }
  | { type: "reopenSession"; id: string }
  | { type: "patchSession"; id: string; cwd?: string; title?: string; note?: string | null; cli?: Session["cli"]; cliId?: string | null }
  | { type: "patchLive"; sessions: Session[] }
  | { type: "renameProject"; id: string; name: string }
  | { type: "reorderProject"; id: string; beforeId: string | null }
  | { type: "deleteProject"; id: string }
  | { type: "setError"; message: string | null };

export const empty: Data = {
  sessions: [],
  projects: [],
  selectedId: null,
  expandedProjectIds: [],
  pinnedSessionIds: [],
  selectedConversationId: null,
  followTerminalConversation: false,
  sessionSeq: 0,
  projectSeq: 0,
  error: null,
};

export function validSelection(sessions: Session[], preferred: string | null, fallback: string | null = null): string | null {
  const valid = (id: string | null) => id != null && sessions.some(s => s.id === id && !s.closed);
  return valid(preferred) ? preferred : valid(fallback) ? fallback : sessions.find(s => !s.closed)?.id ?? null;
}

export function reducer(state: Data, action: Action): Data {
  const next = reduce(state, action);
  const selectedId = validSelection(next.sessions, next.selectedId, state.selectedId);
  return next.selectedId === selectedId ? next : { ...next, selectedId };
}

function reduce(state: Data, action: Action): Data {
  switch (action.type) {
    case "hydrate":
      // 旧后端快照无此字段时回落为空，保证重启前前端可用。
      //
      // selectedConversationId 读到 null 只是「当前不可见」——对话进了回收站时后端
      // 就会这样返回，但底层偏好还在。**绝不能因此回写一次清除**，否则对话从回收站
      // 恢复之后原来的选择就找不回来了。这里只反映，不回写。
      return {
        ...state, ...action.data,
        pinnedSessionIds: action.data.pinnedSessionIds ?? [],
        selectedConversationId: action.data.selectedConversationId ?? null,
        followTerminalConversation: action.data.followTerminalConversation ?? false,
        error: null,
      };
    case "addSession": {
      return {
        ...state,
        sessionSeq: state.sessionSeq + 1,
        sessions: [...state.sessions.filter((s) => s.id !== action.session.id), action.session],
        selectedId: action.session.id,
        error: null,
      };
    }
    case "addProject": {
      return {
        ...state,
        projectSeq: state.projectSeq + 1,
        projects: [...state.projects.filter((p) => p.id !== action.project.id), action.project],
        expandedProjectIds: state.expandedProjectIds.includes(action.project.id)
          ? state.expandedProjectIds
          : [...state.expandedProjectIds, action.project.id],
      };
    }
    case "selectSession": {
      const session = state.sessions.find((s) => s.id === action.id && !s.closed);
      return session ? { ...state, selectedId: action.id } : state;
    }
    case "toggleProject": {
      const open = state.expandedProjectIds;
      return {
        ...state,
        expandedProjectIds: open.includes(action.id)
          ? open.filter((id) => id !== action.id)
          : [...open, action.id],
      };
    }
    case "reorderSession": {
      const moving = state.sessions.find((s) => s.id === action.sessionId);
      if (!moving) return state;
      const rest = state.sessions.filter((s) => s.id !== action.sessionId);
      const updated = { ...moving, projectId: action.projectId };
      const at = action.beforeId == null ? -1 : rest.findIndex((s) => s.id === action.beforeId);
      const sessions = at < 0 ? [...rest, updated] : [...rest.slice(0, at), updated, ...rest.slice(at)];
      const expandedProjectIds =
        action.projectId && !state.expandedProjectIds.includes(action.projectId)
          ? [...state.expandedProjectIds, action.projectId]
          : state.expandedProjectIds;
      return { ...state, sessions, expandedProjectIds };
    }
    case "reorderProject": {
      const moving = state.projects.find((p) => p.id === action.id);
      if (!moving) return state;
      const rest = state.projects.filter((p) => p.id !== action.id);
      const at = action.beforeId == null ? -1 : rest.findIndex((p) => p.id === action.beforeId);
      const projects = at < 0 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)];
      return { ...state, projects };
    }
    case "selectConversation":
      // 对话选择与终端选择相互独立：切换/删除终端都不该动它。
      return { ...state, selectedConversationId: action.id };
    case "setFollowTerminalConversation":
      return { ...state, followTerminalConversation: action.follow };
    case "closeSession": {
      const sessions = state.sessions.map((s) =>
        s.id === action.id ? { ...s, closed: true } : s,
      );
      const selectedId =
        state.selectedId === action.id
          ? (sessions.find((s) => !s.closed)?.id ?? null)
          : state.selectedId;
      return { ...state, sessions, selectedId };
    }
    case "killSession": {
      const sessions = state.sessions.filter((s) => s.id !== action.id);
      const selectedId =
        state.selectedId === action.id
          ? (sessions.find((s) => !s.closed)?.id ?? null)
          : state.selectedId;
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== action.id);
      return { ...state, sessions, selectedId, pinnedSessionIds };
    }
    case "togglePin": {
      const pinned = state.pinnedSessionIds.includes(action.id);
      return {
        ...state,
        pinnedSessionIds: pinned
          ? state.pinnedSessionIds.filter((id) => id !== action.id)
          : [...state.pinnedSessionIds, action.id],
      };
    }
    case "reopenSession": {
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, closed: false } : s,
        ),
        selectedId: action.id,
        error: null,
      };
    }
    case "patchSession": {
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id
            ? {
                ...s,
                cwd: action.cwd ?? s.cwd,
                title: action.title ?? s.title,
                cli: action.cli === undefined ? s.cli : action.cli,
                cliId: "cliId" in action ? action.cliId : s.cliId,
                // 清空备注是合法操作，**必须按键是否存在判断**：用 ?? 的话
                // note: null 会被当成「没传」而保留旧值，永远清不掉。
                note: "note" in action ? action.note : s.note,
              }
            : s,
        ),
      };
    }
    case "patchLive": {
      let changed = false;
      const sessions = state.sessions.map((s) => {
        const live = action.sessions.find((row) => row.id === s.id);
        if (!live) return s;
        const cli = live.cli ?? null;
        if (live.cwd === s.cwd && cli === (s.cli ?? null) && live.cliId === s.cliId) return s;
        changed = true;
        return { ...s, cwd: live.cwd, cli, cliId: live.cliId };
      });
      return changed ? { ...state, sessions } : state;
    }
    case "renameProject": {
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.id ? { ...p, name: action.name } : p,
        ),
      };
    }
    case "deleteProject": {
      const projects = state.projects.filter((p) => p.id !== action.id);
      const sessions = state.sessions.map((s) =>
        s.projectId === action.id ? { ...s, projectId: null } : s,
      );
      return {
        ...state,
        projects,
        sessions,
        expandedProjectIds: state.expandedProjectIds.filter((id) => id !== action.id),
      };
    }
    case "setError":
      return { ...state, error: action.message };
  }
}
