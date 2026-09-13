import type { HistoryCoverage } from "@roost/ai-session-bridge";

export type ConversationSource = {
  id: string; conversationId: string; legacyConversationId: string;
  originScope: "legacy-local"; cliId: string; nativeSessionId: string;
  cwd: string | null; transcriptPath: string | null; locatorStatus: "unverified";
  observedAt: number; coverage: HistoryCoverage;
};
export type ConversationRecord = {
  id: string; title: string; titleOrigin: "native" | "user" | "fallback";
  projectId: string | null; createdAt: number; updatedAt: number; lastMessageAt: number | null;
  archivedAt: number | null; trashedAt: number | null; pinnedAt: number | null;
  revision: number; forkedFromId: string | null; source: ConversationSource;
};
export type ConversationListItem = ConversationRecord & {
  /** First available saved user text, normalized and limited to 120 Unicode code points. */
  firstUserMessagePreview: string | null;
};
export type ConversationListOptions = {
  projectId?: string | null; terminalId?: string; q?: string; state?: "active" | "archived" | "trashed" | "all";
  cursor?: string; limit?: number; sort?: "created" | "activity";
};
export type ConversationRunHistoryOptions = { terminalId?: string; cursor?: string; limit?: number };
/** A saved execution observation. recordedState is never a live PTY assertion. */
export type ConversationRunHistoryItem = {
  id: string; conversationId: string; sourceId: string; provenance: "run" | "generation";
  runId: string | null; webSessionId: string; terminalInstanceId: string; generation: string;
  cliId: string; nativeSessionId: string; startedAt: number; endedAt: number | null;
  recordedState: "active" | "ended" | "unknown"; runtimeVerified: false;
  daemonInstanceId: string | null; ownerEpoch: number | null; reason: string | null;
};
export type ConversationRunHistoryPage = { items: ConversationRunHistoryItem[]; nextCursor: string | null };
export type ConversationPatch = {
  revision: number; title?: string; projectId?: string | null;
  archived?: boolean; trashed?: boolean; pinned?: boolean;
};
export class ConversationError extends Error {
  status: number;
  code: string;
  current?: ConversationRecord;
  constructor(status: number, code: string, message: string, current?: ConversationRecord) {
    super(message); this.name = "ConversationError";
    this.status = status; this.code = code; this.current = current;
  }
}
