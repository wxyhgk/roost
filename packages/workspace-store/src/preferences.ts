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
  /*
    启动台上固定住的应用，按端口。

    **用端口当身份，不用进程。** pid 每次重启都变，而人心里想的就是「5173 那个」——
    dev server 重启之后固定项应该还在原位，否则固定这件事就白做了。代价是端口被另一个
    程序占用时固定项会跟过去；那也正是人的预期。

    校验（整数、1..65535、去重、有上限）集中在这里而不是分散在读写两侧：这张表里的值
    来自 HTTP 请求体，而下游会把它直接拼进 `/api/app/<端口>/`。
  */
  const MAX_PINNED_APPS = 64;
  const validPorts = (ports: readonly unknown[]) =>
    [...new Set(ports.filter((port): port is number =>
      typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535))].slice(0, MAX_PINNED_APPS);
  const setPinnedAppPorts = (ports: number[]) => setMeta("pinnedAppPorts", JSON.stringify(validPorts(ports)));
  const getPinnedAppPorts = (): number[] => {
    const raw = getMeta("pinnedAppPorts");
    if (!raw) return [];
    // 损坏值一律回退空表，理由同上面 stringListMeta：宁可丢排布，不该让工作区加载失败。
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? validPorts(parsed) : [];
    } catch { return []; }
  };
  return { getMeta, setMeta, numberMeta, setSelectedId, setExpandedProjectIds, getExpandedProjectIds,
    setPinnedSessionIds, getPinnedSessionIds, setPinnedAppPorts, getPinnedAppPorts,
    getConversationSelection, patchConversationSelection };
}
export type Preferences = ReturnType<typeof createPreferences>;
