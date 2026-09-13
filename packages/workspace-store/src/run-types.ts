export type ConversationRun = {
  id: string;
  conversationId: string;
  sourceId: string;
  webSessionId: string;
  terminalInstanceId: string;
  generation: string;
  nativeSessionId: string;
  cliId: string;
  daemonInstanceId: string;
  ownerEpoch: number;
  state: "active" | "ended" | "unknown";
  startedAt: number;
  endedAt: number | null;
  reason: string | null;
};

export class ConversationRunError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConversationRunError";
    this.status = status;
    this.code = code;
  }
}
