import { createAiCommands } from './ai-commands.ts';
import { isDefaultSessionTitle } from "./conversation-schema.ts";
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

  /*
    给终端改名时，**把名字一起给到它此刻跑着的那条对话**。

    两边原来是断开的：对话建立时抓的是终端当时的标题，之后终端改名不再传过去。于是
    你把终端改成「roost-前端」，目录里那条对话还叫「Terminal」——同一个东西两个名字，
    而目录是终端删掉之后唯一的回家路，名字对不上就找不着。

    **只覆盖 `fallback`。** CLI 自己起的名字（`native`，比如「B 树讲解」）比一个终端标签
    更贴切；用户在对话详情里亲手改过的（`user`）更不能动。只有那种「Terminal」「claude
    3749983a…」的兜底值才该被顶掉——那种名字本来就不携带信息。

    覆盖之后标成 `user`：**是人打的字**。这样后面 CLI 再报一个自动标题也不会把它盖回去。

    改名失败不影响改终端：终端的名字是用户此刻要的东西，不能因为一个**附带动作**没成
    而回滚。

    这个 catch 现在按构造走不到（同一个 tick 里读的 revision，紧接着就用；单线程，
    中间没人能插进来改），变异测试也因此抓不住它。留着是因为它守的是「主动作不被副作用
    拖累」这条，而副作用这一侧以后还会加东西——那时它就有用了。
  */
  function setSessionTitle(id: string, title: string) {
    sessions.setSessionTitle(id, title);
    try { adoptTerminalTitle(id, title); }
    catch { /* 附带动作，失败不回滚终端改名 */ }
  }

  /** 把终端此刻的名字给到绑在它上面的那条对话；只顶掉兜底标题。返回有没有真的改。 */
  function adoptTerminalTitle(sessionId: string, title: string): boolean {
    const binding = aiSessions.list().find(record => record.binding.webSessionId === sessionId)?.binding;
    if (!binding) return false;
    const conversation = conversations.findBySource(binding.cliId, binding.nativeSessionId);
    if (!conversation || conversation.titleOrigin !== "fallback") return false;
    conversations.patch(conversation.id, { revision: conversation.revision, title });
    return true;
  }

  /*
    **开库时把已经错开的名字对齐一次。**

    改名传播只管「以后」。而库里已经攒下的那些是断开的：终端叫「roost-前端」，它跑着的
    那条对话还叫「Terminal」——同一个东西两个名字，而对话目录是终端删掉之后唯一的回家路。
    只修「以后」等于让用户挨个去重命名一遍，那是把我们的遗留问题派给他做。

    只动 `fallback` 的那些，而且只在终端**真的有名字**时动（`isDefaultSessionTitle`
    和入库那边用的是同一条判据——两处各写一份迟早会漂）。所以「Terminal → Terminal」
    这种不会被碰：那种情况下界面本来就改显示第一条用户消息，比一个兜底标题有用。

    做成**带标记的一次性迁移**（`schema.conversation-title-adopt.v1`），和同一个库里
    另一条存量修正一个套路。不做成每次开库都跑，是因为那样会和别的逻辑反复打架——
    实测就撞到过：`ai-sessions.ts` 那条迁移刚把「冒充 native 的默认标题」降回 fallback，
    这边下一拍又把它升成终端名，那条用例当场红。

    **这一步和那条迁移的自律相反，是有意的。** 它写着「只改来源标记，不动标题文字——
    文字是用户看得见的东西」。那条在一般情形下对，但这里要替换掉的文字是
    `"omp n1"`、`"claude 3749983a…"` 这种**机器拼的占位符**，不是任何人写的东西，
    换掉它什么都没丢；而留着它，用户在目录里就认不出自己的对话。

    失败不影响开库——名字没对齐只是难找，开不了库是什么都没有。
  */
  function reconcileFallbackTitles() {
    try {
      if (db.prepare("SELECT 1 FROM ai_history_meta WHERE key='schema.conversation-title-adopt.v1'").get()) return;
      for (const record of aiSessions.list()) {
        const session = sessions.getSessionRecord(record.binding.webSessionId);
        if (!session || isDefaultSessionTitle(session.title)) continue;
        adoptTerminalTitle(session.id, session.title.trim());
      }
      db.prepare("INSERT INTO ai_history_meta VALUES('schema.conversation-title-adopt.v1','1')").run();
    } catch { /* 对齐失败不该拦住开库 */ }
  }
  reconcileFallbackTitles();

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
    setSessionTitle,
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
