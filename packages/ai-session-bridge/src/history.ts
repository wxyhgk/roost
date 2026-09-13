import type { Binding, BridgeEvent, EventEnvelope } from "./index.ts";

/** Committed alongside the bridge checkpoint; never inferred from a trimmed replay window. */
export type BridgeSaveChanges = {
  events?: EventEnvelope[];
  messages?: BridgeEvent[];
  details?: BridgeEvent[];
};
export type HistoryCoverage = {
  hasGap: boolean;
  transcriptStatus?: string;
  skippedRecords?: number;
};
export type HistoryGeneration = {
  generation: string;
  webSessionId: string;
  conversationId: string;
  ordinal: number;
  binding: Binding;
  openedAt: number;
  closedAt: number | null;
  upperBoundSeq: number;
  coverage: HistoryCoverage;
};
export type HistoryMessage = {
  messageId: string;
  historySeq: number;
  event: BridgeEvent;
  bodyState: "stored" | "source_backed" | "unavailable";
  sourceRevision: number;
};
export type HistoryPage = {
  items: HistoryMessage[];
  nextCursor: string | null;
  hasMore: boolean;
  upperBoundSeq: number;
  historyEpoch: number;
  conversationId: string;
  coverage: HistoryCoverage;
};
export type HistoryStore = {
  listGenerations(webSessionId: string, options?: { beforeOrdinal?: number; limit?: number }): { items: HistoryGeneration[]; nextBeforeOrdinal: number | null };
  pageMessages(webSessionId: string, generation: string, options?: { cursor?: string; limit?: number }): HistoryPage;
  getMessage(webSessionId: string, generation: string, messageId: string): HistoryMessage;
};
export class AiHistoryError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; this.name = "AiHistoryError"; }
}
