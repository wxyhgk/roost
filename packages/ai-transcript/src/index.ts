import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { previewToolArgs } from "./truncate.ts";

export type TranscriptCheckpoint = {
  adapter?: string; state?: Record<string, unknown>;
  path: string; fingerprint: string; offset: number; pending: string; discarding: boolean;
  tail: string; mtimeMs?: number; fileSize: number; skipped: number; active: boolean;
  status: "reading" | "caught_up" | "awaiting_line" | "partial" | "unavailable"; reason?: string;
};
/**
 * 一次文件改动的真实 hunk。
 *
 * **供应商已经算好了，我们只是没去取。** Claude 在 edit 工具结果的记录级
 * `toolUseResult.structuredPatch` 上给出解析过的 unified hunk（实测 12 份 transcript 里
 * 有 30 条非空）。把它压成一行「Edit: src/foo.ts」，等于把 AI coding 对话里用户最关心的
 * 东西——「它到底改了什么」——扔掉。
 *
 * 有上限：hunk 数、总行数、单行长度都封顶，超出标 `truncated`。原始数据可以任意大，
 * 而这份要经过预览、WebSocket 和列表预算。
 */
export type EditPatch = {
  filePath?: string;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[];
  truncated: boolean;
};

export type TranscriptItem = {
  eventId: string; type: "message"; role: string; content: string; createdAt?: number;
  data: { source: "transcript"; nativeMessageId: string; parentId: string | null;
    parts: { type: string; text?: string; toolCallId?: string; name?: string; patch?: EditPatch }[];
    truncated: boolean; detail: { provider?: string; path: string; fingerprint: string; offset: number; length: number; nativeSessionId: string; recordId: string; hash: string } };
};
export class TranscriptError extends Error { constructor(public code: string) { super(code); } }
const BATCH = 256 * 1024, LINE = 1024 * 1024, PREVIEW = 4000;
function fingerprint(stat: {dev: number; ino: number; birthtimeMs: number}) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

export async function discoverOmpTranscript(nativeId: string, roots: string[]): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]{1,512}$/.test(nativeId)) throw new TranscriptError("invalid_native_id");
  let count = 0; const matches: string[] = [];
  async function scan(dir: string, depth: number) {
    let entries;
    try { entries = await opendir(dir); } catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for await (const entry of entries) {
      if (++count > 10000) throw new TranscriptError("discovery_limit");
      if (entry.isFile() && (entry.name.endsWith("_" + nativeId + ".jsonl") || entry.name === nativeId + ".jsonl"))
        matches.push(join(dir, entry.name));
      else if (entry.isDirectory() && depth === 0) await scan(join(dir, entry.name), 1);
    }
  }
  for (const root of roots) await scan(root, 0);
  if (matches.length > 1) throw new TranscriptError("ambiguous_transcript");
  return matches[0] ?? null;
}

async function header(handle: Awaited<ReturnType<typeof open>>, nativeId: string) {
  const buffer = Buffer.alloc(64 * 1024);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row?.type === "session") {
      if (row.id !== nativeId) throw new TranscriptError("session_mismatch");
      if (row.version !== 3) throw new TranscriptError("unsupported_version");
      return;
    }
  }
  throw new TranscriptError("header_unavailable");
}

function normalize(row: Record<string, any>, ref: TranscriptItem["data"]["detail"], full = false): { item?: TranscriptItem; partial: boolean } {
  const known = ["title", "session", "model_change", "thinking_level_change", "custom"];
  if (known.includes(row.type)) return { partial: false };
  if (row.type !== "message") return { partial: true };
  const message = row.message;
  if (!object(message) || typeof row.id !== "string" || !row.id || row.id.length > 256 ||
      !["user", "assistant", "toolResult", "system"].includes(message.role)) return { partial: true };
  const parts: TranscriptItem["data"]["parts"] = [];
  let partial = false, truncated = false, total = 0;
  const limit = full ? 256 * 1024 : message.role === "toolResult" ? PREVIEW : 64 * 1024;
  function add(type: string, text: string, extra = {}) {
    const remaining = Math.max(0, limit - total), output = text.slice(0, remaining);
    truncated ||= output.length < text.length; total += output.length;
    parts.push({ type, text: output, ...extra });
  }
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (!Array.isArray(content)) return { partial: true };
  if (content.length > 512) { partial = true; truncated = true; }
  for (const block of content.slice(0, 512)) {
    if (!object(block)) { partial = true; continue; }
    if (block.type === "text" && typeof block.text === "string") add("text", block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") add("thinking", block.thinking);
    else if (block.type === "toolCall" && typeof block.name === "string") {
      const args = full ? { text: JSON.stringify(block.arguments ?? {}), truncated: false } : previewToolArgs(block.arguments);
      truncated ||= args.truncated;
      add("tool_call", `${block.name}: ${args.text}`, { toolCallId: typeof block.id === "string" ? block.id : undefined, name: block.name });
    } else { partial = true; add("unsupported", "[未支持的记录内容]"); }
  }
  if (message.role === "toolResult") {
    parts.unshift({ type: message.isError ? "tool_error" : "tool_result",
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      name: typeof message.toolName === "string" ? message.toolName : undefined });
  }
  const timestamp = Date.parse(row.timestamp);
  return { partial, item: {
    eventId: "omp:" + ref.nativeSessionId + ":" + row.id, type: "message",
    role: message.role === "toolResult" ? "tool" : message.role,
    content: parts.map(part => part.type === "thinking" ? "[已记录的思考]\n" + part.text : part.text ?? part.name ?? "").join("\n"),
    ...(Number.isFinite(timestamp) ? { createdAt: timestamp } : {}),
    data: { source: "transcript", nativeMessageId: row.id, parentId: typeof row.parentId === "string" ? row.parentId : null,
      parts, truncated, detail: { ...ref, recordId: row.id } },
  } };
}

/** Read at most one byte budget per call, committing partial UTF-8/JSON bytes via checkpoint. */
export async function readOmpTranscript(path: string, nativeId: string, previous?: TranscriptCheckpoint) {
  if (!isAbsolute(path)) throw new TranscriptError("absolute_path_required");
  const canonical = await realpath(path);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TranscriptError("not_file");
    await header(handle, nativeId);
    const identity = fingerprint(stat);
    let reset = !previous || previous.path !== canonical || previous.fingerprint !== identity || stat.size < previous.offset || (previous?.mtimeMs !== undefined && previous.mtimeMs !== stat.mtimeMs && stat.size <= previous.fileSize);
    if (!reset && previous!.tail) {
      const tail = Buffer.from(previous!.tail, "base64"), check = Buffer.alloc(tail.length);
      await handle.read(check, 0, check.length, previous!.offset - tail.length);
      if (!tail.equals(check)) reset = true;
    }
    const state: TranscriptCheckpoint = reset
      ? { path: canonical, fingerprint: identity, offset: 0, pending: "", discarding: false, tail: "", fileSize: stat.size, skipped: 0, active: true, status: "reading" }
      : { ...previous!, active: true, reason: undefined, fileSize: stat.size };
    const buffer = Buffer.alloc(Math.min(BATCH, Math.max(0, stat.size - state.offset)));
    const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, state.offset) : { bytesRead: 0 };
    const oldPending = Buffer.from(state.pending, "base64");
    const combined = Buffer.concat([oldPending, buffer.subarray(0, bytesRead)]);
    let base = state.offset - oldPending.length, start = 0;
    // Details travel beside previews so callers can persist both with the checkpoint
    // without sending large bodies on the live event stream or reopening each row.
    const items: TranscriptItem[] = [], details: TranscriptItem[] = [];
    for (;;) {
      const end = combined.indexOf(10, start);
      if (end < 0) break;
      const line = combined.subarray(start, end);
      if (state.discarding || line.length > LINE) {
        if (!state.discarding) state.skipped++;
        state.discarding = false;
      } else if (line.toString("utf8").trim()) {
        let row; try { row = JSON.parse(line.toString("utf8")); } catch { state.skipped++; start = end + 1; continue; }
        if (!object(row)) state.skipped++;
        else {
          if (row.type === "session" && (row.id !== nativeId || row.version !== 3)) throw new TranscriptError("session_mismatch");
          const ref = { path: canonical, fingerprint: identity, offset: base + start,
            length: end - start, nativeSessionId: nativeId, recordId: "", hash: createHash("sha256").update(line).digest("hex") };
          const result = normalize(row, ref);
          if (result.partial) state.skipped++;
          if (result.item) {
            items.push(result.item);
            details.push(normalize(row, ref, true).item!);
          }
        }
      }
      start = end + 1;
    }
    let pending = combined.subarray(start);
    if (pending.length > LINE) { if (!state.discarding) state.skipped++; state.discarding = true; }
    if (state.discarding) pending = Buffer.alloc(0);
    state.pending = pending.toString("base64"); state.offset += bytesRead;
    const tail = Buffer.alloc(Math.min(64, state.offset));
    if (tail.length) await handle.read(tail, 0, tail.length, state.offset - tail.length);
    state.tail = tail.toString("base64"); state.mtimeMs = stat.mtimeMs;
    const after = await handle.stat();
    if (after.size < state.offset || (after.mtimeMs !== stat.mtimeMs && after.size <= stat.size)) throw new TranscriptError("file_changed_during_read");
    state.status = state.skipped ? "partial" : state.offset < stat.size ? "reading" : state.pending || state.discarding ? "awaiting_line" : "caught_up";
    return { checkpoint: state, items, details, reset, bytesRead };
  } finally { await handle.close(); }
}

export async function readOmpDetail(ref: TranscriptItem["data"]["detail"]) {
  if (!Number.isSafeInteger(ref.length) || ref.length < 0 || ref.length > LINE) throw new TranscriptError("detail_too_large");
  const handle = await open(ref.path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (fingerprint(await handle.stat()) !== ref.fingerprint) throw new TranscriptError("file_replaced");
    await header(handle, ref.nativeSessionId);
    const buffer = Buffer.alloc(ref.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, ref.offset);
    if (bytesRead !== buffer.length) throw new TranscriptError("file_changed");
    if (createHash("sha256").update(buffer).digest("hex") !== ref.hash) throw new TranscriptError("file_changed");
    let row; try { row = JSON.parse(buffer.toString("utf8")); } catch { throw new TranscriptError("file_changed"); }
    if (row?.id !== ref.recordId) throw new TranscriptError("file_changed");
    return normalize(row, ref, true).item;
  } finally { await handle.close(); }
}

export { readClaudeTranscript, readClaudeDetail, discoverClaudeTranscript } from "./claude.ts";
export { readCodexTranscript, readCodexDetail } from "./codex.ts";
export { readOpenCodeTranscript } from "./opencode.ts";

/** Legacy source detail lookup. Durable generation history is preferred. */
export async function readTranscriptDetail(ref: TranscriptItem["data"]["detail"]) {
  if (ref.path.startsWith("http://") || ref.path.startsWith("https://"))
    throw new TranscriptError("use_durable_history_detail");
  // Provider is encoded in a safe optional field, never inferred from filesystem paths.
  const provider = (ref as typeof ref & { provider?: string }).provider;
  if (provider === "claude") return (await import("./claude.ts")).readClaudeDetail(ref);
  if (provider === "qwen") return (await import("./qwen.ts")).readQwenDetail(ref);
  if (provider === "grok") throw new TranscriptError("use_durable_history_detail");
  if (provider === "gemini") throw new TranscriptError("use_durable_history_detail");
  if (provider === "codex") return (await import("./codex.ts")).readCodexDetail(ref);
  return readOmpDetail(ref);
}

export {getTranscriptAdapter, listTranscriptAdapters, type TranscriptAdapter} from './registry.ts';

export {readGeminiTranscript} from './gemini.ts';

export {readQwenTranscript,readQwenDetail,discoverQwenTranscript} from './qwen.ts';

export {readGrokTranscript,discoverGrokTranscript} from './grok.ts';
