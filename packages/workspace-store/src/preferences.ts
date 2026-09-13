import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.ts";
import { ConversationError } from "./conversation-types.ts";
import type { ConversationSelection, ConversationSelectionPatch } from "./types.ts";

export function createPreferences(db: DatabaseSync) {
  function getMeta(key: string) {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }
  function setMeta(key: string, value: string) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }
  function numberMeta(key: string, fallback = 0) {
    const raw = getMeta(key);
    const n = raw ? Number(raw) : fallback;
    return Number.isFinite(n) ? n : fallback;
  }
  // meta 是键值表，列表只能以 JSON 落库。读侧对损坏值一律回退空表：
  // 这些都是「记住上次怎么摆」的偏好，宁可丢排布也不该让整个工作区加载失败。
  function stringListMeta(key: string): string[] {
    const raw = getMeta(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  function setStringListMeta(key: string, ids: string[]) {
    setMeta(key, JSON.stringify(ids));
  }
  function setSelectedId(id: string | null) {
    if (id) setMeta("selectedId", id);
    else db.prepare("DELETE FROM meta WHERE key = ?").run("selectedId");
  }
  function selectedConversation(id: string) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_catalog'").get()) return undefined;
    return db.prepare("SELECT trashed_at FROM conversation_catalog WHERE id=?").get(id) as { trashed_at: number | null } | undefined;
  }
  function getConversationSelection(): ConversationSelection {
    const id = getMeta("selectedConversationId");
    const row = id ? selectedConversation(id) : undefined;
    return {
      // Reading preferences never creates a conversation or starts a terminal.
      // Trashed/missing records are hidden; archive alone does not prevent reading.
      selectedConversationId: row && row.trashed_at === null ? id : null,
      followTerminalConversation: getMeta("followTerminalConversation") === "true",
    };
  }
  function patchConversationSelection(patch: ConversationSelectionPatch): ConversationSelection {
    // Workspace layout preferences use last-write-wins across windows. They never
    // authorize sending/resuming; those operations must carry their own target ID.
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ConversationError(400, "invalid_request", "conversation selection must be an object");
    const hasSelected = "selectedConversationId" in patch;
    const hasFollow = "followTerminalConversation" in patch;
    if (hasSelected && patch.selectedConversationId !== null && (typeof patch.selectedConversationId !== "string" || !patch.selectedConversationId.trim() || patch.selectedConversationId.length > 512)) {
      throw new ConversationError(400, "invalid_request", "selectedConversationId must be a conversation id or null");
    }
    if (hasFollow && typeof patch.followTerminalConversation !== "boolean") throw new ConversationError(400, "invalid_request", "followTerminalConversation must be a boolean");
    return transaction(db, () => {
      if (hasSelected && patch.selectedConversationId !== null) {
        const row = selectedConversation(patch.selectedConversationId!);
        if (!row) throw new ConversationError(404, "not_found", "selected conversation not found");
        if (row.trashed_at !== null) throw new ConversationError(409, "conversation_trashed", "restore the conversation before selecting it");
      }
      if (hasSelected) {
        if (patch.selectedConversationId === null) db.prepare("DELETE FROM meta WHERE key=?").run("selectedConversationId");
        else setMeta("selectedConversationId", patch.selectedConversationId!);
      }
      if (hasFollow) setMeta("followTerminalConversation", String(patch.followTerminalConversation));
      // This is a UI preference only; following a terminal requires an explicit
      // conversation selection update. Terminal selection/deletion cannot write it.
      return getConversationSelection();
    });
  }
  const setExpandedProjectIds = (ids: string[]) => setStringListMeta("expandedProjectIds", ids);
  const getExpandedProjectIds = () => stringListMeta("expandedProjectIds");
  const setPinnedSessionIds = (ids: string[]) => setStringListMeta("pinnedSessionIds", ids);
  const getPinnedSessionIds = () => stringListMeta("pinnedSessionIds");
  return { getMeta, setMeta, numberMeta, setSelectedId, setExpandedProjectIds, getExpandedProjectIds,
    setPinnedSessionIds, getPinnedSessionIds, getConversationSelection, patchConversationSelection };
}
export type Preferences = ReturnType<typeof createPreferences>;
