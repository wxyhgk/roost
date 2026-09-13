import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { WorkspaceStore } from '@roost/workspace-store';
import type { TerminalService } from '@roost/terminal-runtime';

export class FileAccessError extends Error {
  readonly status = 403;
  readonly code = 'root_not_allowed';
  constructor() { super('file root must be an existing terminal working directory'); }
}

/** Only exact canonical working directories are roots; descendants use path. */
export function createFileAccess(store: WorkspaceStore, runtime: TerminalService) {
  function cwd(id: string) {
    const record = store.getSessionRecord(id);
    if (!record) return undefined;
    try { return runtime.isConnected?.() === false ? record.cwd : runtime.getSession(id)?.cwd ?? record.cwd; } catch { return record.cwd; }
  }
  return async (root: string): Promise<string> => {
    if (!root || !isAbsolute(root) || root.includes('\0')) throw new FileAccessError();
    let canonical: string;
    try { canonical = await realpath(root); } catch { throw new FileAccessError(); }
    for (const record of store.loadWorkspace().sessions) {
      const observed = cwd(record.id);
      if (!observed) continue;
      let allowed: string;
      try { allowed = await realpath(observed); } catch { continue; }
      if (allowed === canonical && cwd(record.id) === observed) return canonical;
    }
    throw new FileAccessError();
  };
}
