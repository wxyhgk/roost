import type { WorkspaceSnapshot } from '../api/session';
import type { Session } from '../types';

/** A slow GET must not undo a newer PTY cwd/CLI notification. CLI fields are one identity. */
export function mergeLiveSessionRead(remote: Session[], before: Session[], current: Session[]): Session[] {
  const oldRows = new Map(before.map(row => [row.id, row]));
  const currentRows = new Map(current.map(row => [row.id, row]));
  return remote.map(row => {
    const old = oldRows.get(row.id), local = currentRows.get(row.id);
    if (!local || local === old) return row;
    // The reducer replaces a row on every local update. Identity detects A → B → A
    // updates too; comparing only the final cwd/CLI value would miss that newer event.
    return {
      ...row,
      cwd: local.cwd,
      cli: local.cli,
      cliId: local.cliId,
    };
  });
}

function mergeRows<Row extends { id: string }>(remote: Row[], before: Row[], current: Row[]): Row[] {
  const oldRows = new Map(before.map(row => [row.id, row]));
  const localRows = new Map(current.map(row => [row.id, row]));
  const merged = new Map<string, Row>();
  for (const row of remote) {
    const old = oldRows.get(row.id), local = localRows.get(row.id);
    if (old && !local) continue; // Locally deleted while the request was pending.
    if (!local) merged.set(row.id, row);
    else if (!old) merged.set(row.id, local);
    else {
      const value = { ...row };
      for (const key of Object.keys(local) as (keyof Row)[]) {
        if (!Object.is(local[key], old[key])) value[key] = local[key];
      }
      merged.set(row.id, value);
    }
  }
  for (const row of current) {
    if (!merged.has(row.id) && row !== oldRows.get(row.id)) merged.set(row.id, row);
  }
  const reordered = before.length !== current.length || before.some((row, index) => row.id !== current[index]?.id);
  if (!reordered) return [...merged.values()];
  const result: Row[] = [];
  for (const row of current) {
    const value = merged.get(row.id);
    if (value) { result.push(value); merged.delete(row.id); }
  }
  return [...result, ...merged.values()];
}

/** Initial hydration can discover server rows without erasing actions taken during the read. */
export function mergeWorkspaceRead(
  remote: WorkspaceSnapshot,
  before: WorkspaceSnapshot,
  current: WorkspaceSnapshot,
): WorkspaceSnapshot {
  const result = { ...remote };
  // Preferences and optimistic mutation results belong to the current UI when changed.
  for (const key of [
    'selectedId', 'expandedProjectIds', 'pinnedSessionIds', 'selectedConversationId',
    'followTerminalConversation', 'sessionSeq', 'projectSeq',
  ] as const) {
    if (!Object.is(current[key], before[key])) Object.assign(result, { [key]: current[key] });
  }
  result.projects = mergeRows(remote.projects, before.projects, current.projects);
  result.sessions = mergeLiveSessionRead(mergeRows(remote.sessions, before.sessions, current.sessions), before.sessions, current.sessions);
  return result;
}

/**
 * 这一轮轮询该走全量合并，还是只补活字段。
 *
 * 抽成函数是为了能单独测：判断本身住在 `WorkspaceProvider` 的 effect 里，那儿单测够不着，
 * 而这三个条件里漏掉任何一个的后果都不是报错——
 *
 * - 漏 `first`：首屏拿不到服务端的会话列表
 * - 漏 `stable`：稳定版里改动永远不同步
 * - 漏 `needsFullRead`：乐观写回滚抹掉的东西永远回不来（见 `state.ts` 那段）
 */
export const wantsFullRead = (options: { first: boolean; stable: boolean; needsFullRead?: boolean }) =>
  options.first || options.stable || !!options.needsFullRead;
