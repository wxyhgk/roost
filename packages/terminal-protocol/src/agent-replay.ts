import type { AgentEvent } from "./agent-events";
export type AgentJournalEvent = { terminalInstanceId: string; sourceSeq: number; agent: AgentEvent };
export type AgentReplay = {
  events: AgentJournalEvent[];
  cursor: number;
  highWater: number;
  hasGap: boolean;
  more: boolean;
};
