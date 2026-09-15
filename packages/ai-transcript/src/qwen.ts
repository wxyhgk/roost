import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { TranscriptError, type TranscriptCheckpoint, type TranscriptItem } from "./index.ts";
import { previewToolArgs } from "./truncate.ts";
const BATCH = 256 * 1024, LINE = 1024 * 1024, PREVIEW = 4000;
function fingerprint(stat: {dev: number; ino: number; birthtimeMs: number}) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

export async function discoverQwenTranscript(nativeId: string, roots: string[]): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]{1,512}$/.test(nativeId)) throw new TranscriptError("invalid_native_id");
  let count = 0; const matches: string[] = [];
  async function scan(dir: string, depth: number) {
    let entries;
    try { entries = await opendir(dir); } catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for await (const entry of entries) {
      if (++count > 10000) throw new TranscriptError("discovery_limit");
      if (entry.isFile() && entry.name === nativeId + ".jsonl")
        matches.push(join(dir, entry.name));
      else if (entry.isDirectory() && depth < 2) await scan(join(dir, entry.name), depth + 1);
    }
  }
  for (const root of roots) await scan(root, 0);
  if (matches.length > 1) throw new TranscriptError("ambiguous_transcript");
  return matches[0] ?? null;
}

async function header(handle: Awaited<ReturnType<typeof open>>, nativeId: string) {
  if (!/^[a-zA-Z0-9_-]{1,512}$/.test(nativeId)) throw new TranscriptError("invalid_native_id");
  const buffer = Buffer.alloc(LINE + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (typeof row?.sessionId === "string") {
      if (row.sessionId !== nativeId) throw new TranscriptError("session_mismatch");
      return;
    }
  }
  throw new TranscriptError("header_unavailable");
}

function normalize(row: Record<string, any>, ref: TranscriptItem["data"]["detail"], full = false): { item?: TranscriptItem; partial: boolean } {
  if (row.type === "system") return { partial: false };
  if (!["user", "assistant", "tool_result"].includes(row.type)) return { partial: true };
  if (row.sessionId !== ref.nativeSessionId) throw new TranscriptError("session_mismatch");
  if (typeof row.uuid !== "string" || !row.uuid || row.uuid.length > 256 || !object(row.message) || !Array.isArray(row.message.parts)) return { partial: true };
  // Qwen stores API-shaped Gemini parts, not Claude message.content blocks.
  const parts: TranscriptItem["data"]["parts"] = [];
  let partial = false, truncated = false, total = 0;
  const limit = full ? 256 * 1024 : row.type === "tool_result" ? PREVIEW : 64 * 1024;
  function add(type: string, text: string, extra = {}) {
    const output = text.slice(0, Math.max(0, limit - total)); total += output.length;
    truncated ||= output.length < text.length; parts.push({ type, text: output, ...extra });
  }
  const display = row.type === "user" && typeof row.systemPayload?.displayText === "string" ? row.systemPayload.displayText : undefined;
  if (display !== undefined) add("text", display);
  else for (const p of row.message.parts.slice(0, 512)) {
    if (!object(p)) { partial = true; continue; }
    if (typeof p.text === "string") add(p.thought === true ? "thinking" : "text", p.text);
    else if (object(p.functionCall) && typeof p.functionCall.name === "string") {
      const c = p.functionCall;
      const args = full ? { text: JSON.stringify(c.args ?? {}), truncated: false } : previewToolArgs(c.args);
      truncated ||= args.truncated;
      add("tool_call", c.name + ": " + args.text, { name: c.name, toolCallId: typeof c.id === "string" ? c.id : undefined });
    } else if (object(p.functionResponse) && typeof p.functionResponse.name === "string") {
      const r = p.functionResponse;
      add(r.response?.error ? "tool_error" : "tool_result", JSON.stringify(r.response ?? {}), {name: r.name, toolCallId: typeof r.id === "string" ? r.id : row.toolCallResult?.callId});
    } else { partial = true; add("unsupported", "[未支持的记录内容]"); }
  }
  if (row.message.parts.length > 512) { partial = true; truncated = true; }
  const timestamp = Date.parse(row.timestamp);
  return { partial, item: { eventId: "qwen:" + ref.nativeSessionId + ":" + row.uuid, type: "message",
    role: row.type === "tool_result" ? "tool" : row.provenance === "system" || row.provenance === "goal_runtime" ? "system" : row.type,
    content: parts.map(p => p.type === "thinking" ? "[已记录的思考]\n" + p.text : p.text ?? "").join("\n"),
    ...(Number.isFinite(timestamp) ? {createdAt: timestamp} : {}),
    data: {source: "transcript", nativeMessageId: row.uuid, parentId: typeof row.parentUuid === "string" ? row.parentUuid : null,
      parts, truncated, detail: {...ref, recordId: row.uuid}},
  }};
}

/** Read at most one byte budget per call, committing partial UTF-8/JSON bytes via checkpoint. */
export async function readQwenTranscript(path: string, nativeId: string, previous?: TranscriptCheckpoint) {
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
          if (typeof row.sessionId === "string" && row.sessionId !== nativeId) throw new TranscriptError("session_mismatch");
          const ref = { provider: "qwen" as const, path: canonical, fingerprint: identity, offset: base + start,
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

export async function readQwenDetail(ref: TranscriptItem["data"]["detail"]) {
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
    if (row?.uuid !== ref.recordId) throw new TranscriptError("file_changed");
    return normalize(row, ref, true).item;
  } finally { await handle.close(); }
}
