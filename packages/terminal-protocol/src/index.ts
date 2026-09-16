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
/**
 * 重放数据里的一个几何切换点：写到 `data[at]` **之前**先把网格改成 `cols`×`rows`。
 *
 * **是偏移不是副本。** 段落本来可以直接发成一串 `{cols,rows,data}`，但那样要么把 data
 * 发两遍（老客户端还得读旧字段），要么加一轮能力协商。偏移只有几十个字节，老客户端
 * 不认这个字段就按一整块写——正是这一笔之前的行为。
 *
 * 索引是 JS 字符串下标（UTF-16 码元）。两端都是 JS，中间是 JSON，数法一致。
 */
export type ReplayResize = TerminalGrid & { at: number };
export type ReplayFrame = ResumeSnapshot & {
  type: "replay" | "catchup";
  revived: boolean;
  truncated: boolean;
  /**
   * 这段重放数据横跨过的几何变化，按 `at` 升序。
   *
   * 会话中途改过尺寸时，环里的旧字节是按**当时**的宽度产出的。整段按最终宽度重放，
   * 等于把它们重新折行——TUI 的 cursor-up 重绘就落在半帧上。帧级的 `cols`/`rows`
   * 是**起始**几何（快照那一份），这里是此后的每一次切换。
   */
  resizes?: ReplayResize[];
};
export type ServerMessage =
  /** `cols`/`rows` 是 PTY **现在**的尺寸——多个观众共用一个 PTY，客户端要靠它判断自己是否落后。 */
  | { type: "hello"; protocol: typeof PROTOCOL_VERSION; instanceId: string; pid: number; heartbeat?: 1; dead?: false; cwd: string; cols?: number; rows?: number; cli: CliKind | null; cliId?: CliId | null;
      /** 守护进程会按流序回 `size` 帧。**问能力，不问版本**：没有它就退回就地重排。 */
      sizeEcho?: true }
  | { type: "hello"; protocol?: typeof PROTOCOL_VERSION; instanceId?: string; pid: null; dead: true; cwd: string; cli: CliKind | null; cliId?: CliId | null }
  | { type: "pong"; nonce: number }
  | OutputFrame
  | ReplayFrame
  /*
    **尺寸回声**：守护进程应用一次 resize 时，往输出流里按序插一帧。

    它标的是「从这一帧往后，字节是新宽度的」。客户端据此把自己的 reflow **推迟到这个
    位置**，而不是窗口一变就重排——否则已经在路上的旧宽度字节会被按新宽度解析，画面就花
    了。跨太平洋的链路上在途字节最多，这个窗口恰好开到最大。

    没有这一帧的旧守护进程：客户端退回「请求时就地重排」，也就是这一笔之前的行为。
    能力位在 hello 的 `sizeEcho` 上（见上面那条 hello）。

    刻意**不带 seq**：帧按序投递、最后一个赢。订阅和取快照之间插进来的那次 resize，快照
    本身已经是新尺寸，于是随后投递的这一帧是个空操作——不会把客户端设回旧尺寸。
  */
  | { type: "size"; cols: number; rows: number; instanceId: string }
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
