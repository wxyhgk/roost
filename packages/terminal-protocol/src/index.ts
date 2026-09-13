export * from "./agent-events.ts";
/** Browser-safe terminal wire contracts shared by transport, runtime and UI. */
export const PROTOCOL_VERSION = 2 as const;
export const MAX_SNAPSHOT_LENGTH = 512_000;
/** Shared outbound transport ceiling; this is a byte limit, not a JS string length. */
export const MAX_TERMINAL_PENDING_BYTES = 4 * 1024 * 1024;
/** Reserve the largest WebSocket frame header, including a possible mask. */
export const WS_FRAME_OVERHEAD_BYTES = 14;
export const MAX_REPLAY_JSON_BYTES = MAX_TERMINAL_PENDING_BYTES - WS_FRAME_OVERHEAD_BYTES;
/**
 * How long a PTY must produce nothing before the session-status feed calls it 'quiet'.
 * Ships on every status frame as `quietAfterMs`; it answers "is this still streaming right
 * now", never "has the AI finished". The UI layers its own, longer thresholds on top —
 * see frontend/src/features/session-status/quietThresholds.ts.
 */
export const QUIET_STATE_AFTER_MS = 3_000;
// JSON can escape each snapshot control character into six bytes.
// The frame cap must stay above the worst escaped snapshot.
export const MAX_WS_BYTES = 8 * 1024 * 1024;

// CLI identity is open-ended. Built-in image capability IDs remain in cli-adapters.
export type CliId = string;
export type CliKind = CliId;
export type ReplayCursor = { instanceId: string; seq: number };
/** Grid used to parse a serialized screen; optional for legacy peers. */
export type TerminalGrid = { cols: number; rows: number };
export function terminalGrid(value: { cols?: unknown; rows?: unknown } | null | undefined): TerminalGrid | undefined {
  if (!value || !Number.isInteger(value.cols) || !Number.isInteger(value.rows)) return undefined;
  const cols = value.cols as number, rows = value.rows as number;
  return cols >= 1 && cols <= 1000 && rows >= 1 && rows <= 1000 ? { cols, rows } : undefined;
}
export type ResumeSnapshot = ReplayCursor & { data: string; cols?: number; rows?: number };
export type OutputFrame = ResumeSnapshot & { type: "output" };
export type ReplayFrame = ResumeSnapshot & {
  type: "replay" | "catchup";
  revived: boolean;
  truncated: boolean;
};
export type ServerMessage =
  /** `cols`/`rows` 是 PTY **现在**的尺寸——多个观众共用一个 PTY，客户端要靠它判断自己是否落后。 */
  | { type: "hello"; protocol: typeof PROTOCOL_VERSION; instanceId: string; pid: number; heartbeat?: 1; dead?: false; cwd: string; cols?: number; rows?: number; cli: CliKind | null; cliId?: CliId | null }
  | { type: "hello"; protocol?: typeof PROTOCOL_VERSION; instanceId?: string; pid: null; dead: true; cwd: string; cli: CliKind | null; cliId?: CliId | null }
  | { type: "pong"; nonce: number }
  | OutputFrame
  | ReplayFrame
  | { type: "exit"; reason?: string; exitCode?: number; signal?: number }
  | { type: "cwd"; cwd: string }
  | { type: "appearance-owner"; owner: boolean }
  /** 同一个终端现在有哪些观众。多个观众共用一个 PTY，尺寸只能有一个赢家——先让用户看得见。 */
  | { type: "viewers"; viewers: { label: string }[]; self: number }
  | { type: "cli"; cli: CliKind | null; cliId?: CliId | null };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ClientMessage = {
  type: "ready" | "resize" | "snapshot" | "input" | "appearance-response" | "ping";
  nonce?: number;
  cols?: number;
  rows?: number;
  data?: string;
  haveSnapshot?: boolean;
  preferRaw?: boolean;
  protocol?: typeof PROTOCOL_VERSION;
  instanceId?: string;
  seq?: number;
  afterSeq?: number;
};

export function parseClientMessage(raw: string): ClientMessage {
  const value: unknown = JSON.parse(raw);
  if (!isObject(value)) throw new Error("message object required");
  if (typeof value.type !== "string" || !["ready", "resize", "snapshot", "input", "appearance-response", "ping"].includes(value.type)) {
    throw new Error("unknown message type");
  }
  if (value.type === "ping" && (!Number.isSafeInteger(value.nonce) || (value.nonce as number) < 0)) throw new Error("invalid heartbeat nonce");
  if ("protocol" in value && value.protocol !== PROTOCOL_VERSION) throw new Error("unsupported terminal protocol");
  if ("instanceId" in value && (typeof value.instanceId !== "string" || !value.instanceId || value.instanceId.length > 128)) {
    throw new Error("invalid terminal instance");
  }
  for (const key of ["seq", "afterSeq"]) {
    if (key in value && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0)) {
      throw new Error("invalid output sequence");
    }
  }
  if (("seq" in value || "afterSeq" in value) && typeof value.instanceId !== "string") {
    throw new Error("terminal instance required for output sequence");
  }
  if (value.type === "input" || value.type === "snapshot" || value.type === "appearance-response") {
    if (typeof value.data !== "string") throw new Error("data string required");
  }
  if (value.type === "appearance-response" && (typeof value.instanceId !== "string" || (value.data as string).length > 1024)) {
    throw new Error("invalid appearance response");
  }
  if (value.type === "ready" || value.type === "resize") {
    if (value.type === "resize" || "cols" in value || "rows" in value) {
      for (const key of ["cols", "rows"]) {
        const size = value[key];
        if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 1000) {
          throw new Error("invalid terminal dimensions");
        }
      }
    }
    for (const key of ["haveSnapshot", "preferRaw"]) {
      if (key in value && typeof value[key] !== "boolean") throw new Error("invalid flag");
    }
  }
  return value as ClientMessage;
}

export type { AgentJournalEvent, AgentReplay } from "./agent-replay";
export * from './ai-commands.ts';
