import type { WorkspaceSnapshot } from '../api';

export const STORAGE_KEY = 'roost-workspace';

/** Local metadata is optional: quota/security failures must not unmount live terminals. */
export function saveWorkspaceCache(state: WorkspaceSnapshot, storage: () => Pick<Storage, 'setItem'> = () => localStorage): boolean {
  try {
    const { sessions, projects, selectedId, expandedProjectIds, pinnedSessionIds, pinnedAppPorts, sessionSeq, projectSeq } = state;
    storage().setItem(STORAGE_KEY, JSON.stringify({ sessions, projects, selectedId, expandedProjectIds, pinnedSessionIds, pinnedAppPorts, sessionSeq, projectSeq }));
    return true;
  } catch { return false; }
}
