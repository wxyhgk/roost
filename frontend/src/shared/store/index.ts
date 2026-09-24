import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  closeSession as closeRemoteSession,
  createProject as createRemoteProject,
  createSession as createRemoteSession,
  deleteProject as deleteRemoteProject,
  fetchWorkspace,
  killSession as killRemoteSession,
  patchProject as patchRemoteProject,
  patchSession as patchRemoteSession,
  patchWorkspace,
  reopenSession as reopenRemoteSession,
  type WorkspaceSnapshot,
} from "../api";
import { failRemote, syncOptimistic } from "./sync";
import type { Session } from "../types";

import { empty, reducer, type Data } from "./state";
import { createObservable, selectFields } from "./observable";
import { stableRuntime } from '../runtime';

import { saveWorkspaceCache, STORAGE_KEY } from "./cache";
import { t } from "@roost/i18n";
import { createWorkspacePoller } from './poll';
import { wantsFullRead, mergeLiveSessionRead, mergeWorkspaceRead } from './read';
export function isOpen(session: Session) {
  return !session.closed;
}

function load(): Data {
  if (stableRuntime) return empty;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Data>;
    return reducer(empty, { type: "hydrate", data: { ...empty, ...parsed } });
  } catch {
    return empty;
  }
}

export type Workspace = Data & {
  /**
   * 开一个新终端。
   *
   * `projectId` 是它落在哪个工作区——**必须由调用方给**：从某个工作区的画布上按下
   * 「新建终端」，它就该出现在那个工作区里，而不是掉进「未分组」。
   */
  addSession: (projectId?: string | null) => void;
  addProject: () => void;
  selectSession: (id: string) => void;
  toggleProject: (id: string) => void;
  reorderSession: (sessionId: string, projectId: string | null, beforeId: string | null) => void;
  togglePin: (id: string) => void;
  /** 选中一条长期对话。传 null 清除选择。与终端选择相互独立。 */
  selectConversation: (id: string | null) => void;
  setFollowTerminalConversation: (follow: boolean) => void;
  closeSession: (id: string) => void;
  killSession: (id: string) => void;
  reopenSession: (id: string) => void;
  patchCwd: (id: string, cwd: string) => void;
  patchCli: (id: string, cli: Session["cli"], cliId?: string | null) => void;
  renameSession: (id: string, title: string) => void;
  /** 保存备注。传 null 或空串都清空。 */
  setSessionNote: (id: string, note: string | null) => void;
  renameProject: (id: string, name: string) => void;
  reorderProject: (id: string, beforeId: string | null) => void;
  deleteProject: (id: string) => void;
};

type WorkspaceActions = Omit<Workspace, keyof Data>;
type WorkspaceSource = { snapshot: () => Data; subscribe: (fn: () => void) => () => void; actions: WorkspaceActions };
const WorkspaceContext = createContext<WorkspaceSource | null>(null);

async function migrateIfNeeded(remote: WorkspaceSnapshot, signal: AbortSignal) {
  signal.throwIfAborted();
  if (stableRuntime) return remote;
  if (remote.sessions.length > 0 || remote.projects.length > 0) return remote;
  const local = load();
  if (local.sessions.length === 0 && local.projects.length === 0) return remote;
  for (const project of local.projects) {
    signal.throwIfAborted();
    await createRemoteProject({
      id: project.id,
      name: project.name,
      color: project.color,
    });
  }
  for (const session of local.sessions) {
    signal.throwIfAborted();
    await createRemoteSession({
      id: session.id,
      cwd: session.cwd,
      title: session.title,
      projectId: session.projectId,
      closed: session.closed,
    });
  }
  // 刻意不迁移 selectedConversationId / followTerminalConversation。
  //
  // 对话进回收站时后端读取会返回 null（底层偏好仍在），把这个 null 迁移回去
  // 就等于替用户清除了选择——对话从回收站恢复之后原来的选择再也找不回来。
  // 这两个偏好只在用户显式操作时写入。
  signal.throwIfAborted();
  await patchWorkspace({
    selectedId: local.selectedId,
    expandedProjectIds: local.expandedProjectIds,
    pinnedSessionIds: local.pinnedSessionIds ?? [],
  });
  // Hydrate the migrated rows, not the empty snapshot read before creating them.
  signal.throwIfAborted();
  return fetchWorkspace(signal);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(load);
  const [source] = useState(() => createObservable(initial, reducer));
  const hydrated = useRef(false);
  const { dispatch } = source;
  const state = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot);

  useEffect(() => {
    const poller = createWorkspacePoller({
      visible: document.visibilityState !== 'hidden',
      read: async signal => {
        const first = !hydrated.current;
        const before = first ? initial : source.snapshot();
        const remote = await fetchWorkspace(signal);
        const data = first ? await migrateIfNeeded(remote, signal) : remote;
        return { first, before, data };
      },
      apply: ({ first, before, data }) => {
        const current = source.snapshot();
        if (wantsFullRead({ first, stable: stableRuntime, needsFullRead: current.needsFullRead })) {
          const merged = mergeWorkspaceRead(data, before, current);
          if (stableRuntime && !first && merged.sessions.some(s => s.id === current.selectedId)) merged.selectedId = current.selectedId;
          dispatch({ type: 'hydrate', data: merged });
        } else {
          dispatch({ type: 'patchLive', sessions: mergeLiveSessionRead(data.sessions, before.sessions, current.sessions) });
        }
        hydrated.current = true;
      },
      onError: () => {
        if (!hydrated.current) dispatch({ type: 'setError', message: t.misc.store.connectRetry });
      },
    });
    const visibilityChanged = () => poller.setVisible(document.visibilityState !== 'hidden');
    const pageShown = () => poller.refresh();
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('pageshow', pageShown);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('pageshow', pageShown);
      poller.dispose();
    };
  }, [source, dispatch, initial]);

  useEffect(() => {
    // Stable mode discovers sessions from core and must not overwrite development metadata.
    if (!stableRuntime) saveWorkspaceCache(state);
  }, [state]);

  const actions = useMemo<WorkspaceActions>(
    () => ({
      addSession: (projectId = null) => {
        const title = "Terminal";
        void createRemoteSession({ title, projectId })
          .then((session) => dispatch({ type: "addSession", session }))
          .catch((err: unknown) => failRemote(dispatch, err, t.misc.store.createSessionFailed));
      },
      addProject: () => {
        void createRemoteProject()
          .then((project) => dispatch({ type: "addProject", project }))
          .catch((err: unknown) => failRemote(dispatch, err, t.misc.store.createProjectFailed));
      },
      selectSession: (id) => {
        const before = source.snapshot();
        dispatch({ type: "selectSession", id });
        if (stableRuntime) return;
        syncOptimistic(patchWorkspace({ selectedId: id }), dispatch, t.misc.store.selectSessionFailed, before);
      },
      toggleProject: (id) => {
        const open = source.snapshot().expandedProjectIds.includes(id)
          ? source.snapshot().expandedProjectIds.filter((x) => x !== id)
          : [...source.snapshot().expandedProjectIds, id];
        const before = source.snapshot();
        dispatch({ type: "toggleProject", id });
        syncOptimistic(patchWorkspace({ expandedProjectIds: open }), dispatch, t.misc.store.toggleProjectFailed, before);
      },
      reorderSession: (sessionId, projectId, beforeId) => {
        const before = source.snapshot();
        dispatch({ type: "reorderSession", sessionId, projectId, beforeId });
        syncOptimistic(patchRemoteSession(sessionId, { projectId, beforeId }), dispatch, t.misc.store.reorderFailed, before);
      },
      togglePin: (id) => {
        const pinned = source.snapshot().pinnedSessionIds.includes(id);
        const pinnedSessionIds = pinned
          ? source.snapshot().pinnedSessionIds.filter((x) => x !== id)
          : [...source.snapshot().pinnedSessionIds, id];
        const before = source.snapshot();
        dispatch({ type: "togglePin", id });
        syncOptimistic(patchWorkspace({ pinnedSessionIds }), dispatch, t.misc.store.togglePinFailed, before);
      },
      selectConversation: (id: string | null) => {
        const before = source.snapshot();
        dispatch({ type: "selectConversation", id });
        syncOptimistic(patchWorkspace({ selectedConversationId: id }), dispatch, t.misc.store.selectConversationFailed, before);
      },
      setFollowTerminalConversation: (follow: boolean) => {
        const before = source.snapshot();
        dispatch({ type: "setFollowTerminalConversation", follow });
        syncOptimistic(patchWorkspace({ followTerminalConversation: follow }), dispatch, t.misc.store.followConversationFailed, before);
      },
      closeSession: (id) => {
        const before = source.snapshot();
        dispatch({ type: "closeSession", id });
        syncOptimistic(closeRemoteSession(id), dispatch, t.misc.store.closeFailed, before);
      },
      killSession: (id) => {
        const before = source.snapshot();
        dispatch({ type: "killSession", id });
        syncOptimistic(
          Promise.all([
            killRemoteSession(id),
            patchWorkspace({ pinnedSessionIds: before.pinnedSessionIds.filter((x) => x !== id) }),
          ]),
          dispatch,
          t.misc.store.killFailed,
          before,
        );
      },
      reopenSession: (id) => {
        void reopenRemoteSession(id)
          .then(() => dispatch({ type: "reopenSession", id }))
          .catch((err: unknown) => failRemote(dispatch, err, t.misc.store.reopenFailed));
      },
      patchCwd: (id, cwd) => dispatch({ type: "patchSession", id, cwd }),
      patchCli: (id, cli, cliId) => dispatch({ type: "patchSession", id, cli, cliId }),
      renameSession: (id, title) => {
        const next = title.trim();
        if (!next) return;
        const before = source.snapshot();
        dispatch({ type: "patchSession", id, title: next });
        syncOptimistic(patchRemoteSession(id, { title: next }), dispatch, t.misc.store.renameSessionFailed, before);
      },
      setSessionNote: (id, note) => {
        // 归一交给后端（它同样会 trim 并把空值统一成 null），但本地乐观更新也要
        // 按同一套规则，否则保存后界面会先闪一下空白备注再被服务端值纠正。
        const next = note?.trim() ? note.trim() : null;
        const before = source.snapshot();
        dispatch({ type: "patchSession", id, note: next });
        syncOptimistic(patchRemoteSession(id, { note: next }), dispatch, t.misc.store.saveNoteFailed, before);
      },
      reorderProject: (id, beforeId) => {
        const before = source.snapshot();
        dispatch({ type: "reorderProject", id, beforeId });
        syncOptimistic(patchRemoteProject(id, { beforeId }), dispatch, t.misc.store.reorderProjectFailed, before);
      },
      renameProject: (id, name) => {
        const next = name.trim();
        if (!next) return;
        const before = source.snapshot();
        dispatch({ type: "renameProject", id, name: next });
        syncOptimistic(patchRemoteProject(id, { name: next }), dispatch, t.misc.store.renameProjectFailed, before);
      },
      deleteProject: (id) => {
        const before = source.snapshot();
        dispatch({ type: "deleteProject", id });
        syncOptimistic(deleteRemoteProject(id), dispatch, t.misc.store.deleteProjectFailed, before);
      },
    }),
    [source, dispatch],
  );

  const value = useMemo(() => ({ ...source, actions }), [source, actions]);

  return createElement(WorkspaceContext.Provider, { value }, children);
}

export function useWorkspace<K extends keyof Workspace>(...keys: [K, ...K[]]): Pick<Workspace, K> {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  // Stable key signature supports literal field lists at call sites.
  const signature = keys.join(",");
  const read = useMemo(() => selectFields(() => ({ ...ctx.snapshot(), ...ctx.actions }), keys), [ctx, signature]);
  return useSyncExternalStore(ctx.subscribe, read, read);
}
