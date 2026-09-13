import { createAiCommands } from './ai-commands.ts';
import { createConversations } from './conversations.ts';
import { createConversationRuns } from './conversation-runs.ts';
import { createPeerMessages } from './peer-messages.ts';
import { createConversationChanges, installConversationChangeTriggers } from './conversation-changes.ts';
import { atomic } from './ai-history.ts';
import { createAgentJournal } from "./agent-journal.ts";
import { createAiSessionStorage } from "./ai-sessions.ts";
import { createCliConfigs } from "./cli-configs.ts";
import { createBookmarks } from "./bookmarks.ts";
import { createLibrary } from "./library.ts";
import { openDatabase } from "./database.ts";
import { createPreferences } from "./preferences.ts";
import { createProjects } from "./projects.ts";
import { createSessions } from "./sessions.ts";
import { createReplayStorage } from "./replay.ts";
import type { WorkspaceSnapshot, WorkspaceStoreOptions } from "./types.ts";

export function createWorkspaceStore({ dataDir }: WorkspaceStoreOptions) {
  const db = openDatabase(dataDir);
  try {
    return initializeWorkspaceStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

function initializeWorkspaceStore(db: ReturnType<typeof openDatabase>) {
  const preferences = createPreferences(db);
  const projects = createProjects(db, preferences);
  const sessions = createSessions(db, preferences);
  const replay = createReplayStorage(db);
  const library = createLibrary(db);
  const aiSessions = createAiSessionStorage(db);
  const conversations = createConversations(db);
  const agentJournal = createAgentJournal(db);
  const aiCommands = createAiCommands(db);
  const conversationRuns = createConversationRuns(db);
  const peerMessages = createPeerMessages(db);
  const conversationChanges = createConversationChanges(db);
  installConversationChangeTriggers(db);

  function conversationSnapshot(id: string) {
    return atomic(db, () => ({
      conversation: conversations.get(id),
      messages: conversations.pageMessages(id, { limit: 10 }),
      inbox: peerMessages.inbox(id, { limit: 10 }),
      outbox: peerMessages.outbox(id, { limit: 10 }),
      run: conversationRuns.active(id) ?? null,
      cursor: conversationChanges.snapshotCursor(id),
    }));
  }

  function loadWorkspace(): WorkspaceSnapshot {
    return {
      sessions: sessions.listSessions(),
      projects: projects.listProjects(),
      selectedId: preferences.getMeta("selectedId"),
      ...preferences.getConversationSelection(),
      expandedProjectIds: preferences.getExpandedProjectIds(),
      pinnedSessionIds: preferences.getPinnedSessionIds(),
      sessionSeq: preferences.numberMeta("sessionSeq"),
      projectSeq: preferences.numberMeta("projectSeq"),
    };
  }

  function deleteProjectRecord(id: string): boolean {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!projects.getProjectRecord(id)) {
        db.exec("COMMIT");
        return false;
      }
      // Cross-domain changes share this connection and this transaction.
      const expanded = preferences.getExpandedProjectIds();
      sessions.ungroupProjectSessions(id);
      conversations.ungroupProject(id);
      preferences.setExpandedProjectIds(expanded.filter(projectId => projectId !== id));
      projects.deleteProjectRow(id);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function deleteSessionRecord(id: string) {
    db.exec("SAVEPOINT delete_session_record");
    try {
      // Keep native receipts after terminal deletion; they may be the only
      // evidence that a command reached the original conversation.
      aiCommands.invalidate(id, 'terminal_deleted');
      conversationRuns.endTerminal(id, 'terminal_deleted');
      agentJournal.remove(id);
      aiSessions.remove(id);
      replay.deleteTerminalReplay(id);
      sessions.deleteSessionRow(id);
      // 置顶表是一串裸 ID，没有外键跟着删；不在这里剔除就会攒下已死会话的 ID。
      const pinned = preferences.getPinnedSessionIds();
      if (pinned.includes(id)) preferences.setPinnedSessionIds(pinned.filter(sessionId => sessionId !== id));
      db.exec("RELEASE delete_session_record");
    } catch (error) {
      db.exec("ROLLBACK TO delete_session_record; RELEASE delete_session_record");
      throw error;
    }
  }

  // Keep the existing public surface; row-level helpers stay package-internal.
  return {
    conversationRuns,
    peerMessages,
    conversationChanges,
    conversationSnapshot,
    conversations,
    aiCommands,
    agentJournal,
    aiSessions,
    cliConfigs: createCliConfigs(db),
    bookmarks: createBookmarks(db),
    library,
    loadWorkspace,
    getSessionRecord: sessions.getSessionRecord,
    upsertSession: sessions.upsertSession,
    setSessionClosed: sessions.setSessionClosed,
    setSessionCwd: sessions.setSessionCwd,
    setSessionProject: sessions.setSessionProject,
    setSessionTitle: sessions.setSessionTitle,
    setSessionNote: sessions.setSessionNote,
    reorderSession: sessions.reorderSession,
    getProjectRecord: projects.getProjectRecord,
    setProjectName: projects.setProjectName,
    deleteProjectRecord,
    createProject: projects.createProject,
    reorderProject: projects.reorderProject,
    setSelectedId: preferences.setSelectedId,
    patchConversationSelection: preferences.patchConversationSelection,
    setExpandedProjectIds: preferences.setExpandedProjectIds,
    setPinnedSessionIds: preferences.setPinnedSessionIds,
    deleteSessionRecord,
    getTerminalReplay: replay.getTerminalReplay,
    setTerminalReplay: replay.setTerminalReplay,
    deleteTerminalReplay: replay.deleteTerminalReplay,
    listSessionIds: sessions.listSessionIds,
    close: () => db.close(),
  };
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
