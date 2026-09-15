import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TranscriptError, type TranscriptCheckpoint, type TranscriptItem } from "./index.ts";
import { previewToolArgs, previewToolText } from "./truncate.ts";
import { contextText } from "./context-injection.ts";
const BATCH = 256 * 1024, LINE = 1024 * 1024;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function fingerprint(stat: {dev: number; ino: number; birthtimeMs: number}) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
async function header(handle: Awaited<ReturnType<typeof open>>, nativeId: string) {
  const buffer = Buffer.alloc(64 * 1024);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  // session_meta must be the first complete record; never bind a child or nearby rollout.
  const end = buffer.subarray(0, bytesRead).indexOf(10);
  if (end < 0) throw new TranscriptError("header_unavailable");
  let row; try { row = JSON.parse(buffer.subarray(0, end).toString("utf8")); } catch { throw new TranscriptError("header_unavailable"); }
  if (row?.type !== "session_meta") throw new TranscriptError("unsupported_format");
  if (!nativeId || row.payload?.id !== nativeId) throw new TranscriptError("session_mismatch");
}
function recordId(row: Record<string, any>, offset: number): string {
  const payload = row?.payload;
  return typeof payload?.id === "string" && payload.id.length > 0 && payload.id.length <= 256
    ? payload.id : `row:${offset}`;
}
/** codex 的参数存成 JSON 字符串：解得回对象就交给结构截断，解不回就原样当字符串。 */
function parseArgs(raw: string): unknown {
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : raw; } catch { return raw; }
}
/**
 * codex 这边的「模型看到了什么」：`world_state`。
 *
 * 它是 Claude `attachment` 在 codex 里唯一对得上的东西——一份环境与指令的快照，
 * `payload.state` 里装着 `agents_md` / `environments` / `permissions` / `skills` / `model`
 * 这些键，正是 Claude 用 `environment` + `instructions` + `skill_listing` 几条分别记的那些。
 * 此前它走到 `response_item` 那道门闸上被当成解析失败计进 `skipped`。
 *
 * **只认这一种，档位固定 `collapsed`。** 本机只有一份 codex rollout、3 条 `world_state`，
 * 证据量不足以像 Claude 那边一样分档；而配置快照本来就属于「留着、折起来」的那一档。
 * 它没有 `rendered` 这样的现成文本，所以走 `contextText` 的 JSON 兜底。
 *
 * **没有一并认的**：`turn_context`（已经在上面被静默忽略）、`thread_settings_applied`、
 * `token_usage_record`、`item_completed`——它们仍然计进 `skipped`。那是另一批记录、
 * 另一个决定。另外 codex 把 `<environment_context>` 这类注入写成普通的 user / developer
 * 消息，和真人说的话在记录里长得一模一样，认不出来也就没法标记，见交付说明。
 */
function worldState(row: Record<string, any>, ref: TranscriptItem["data"]["detail"], full: boolean): { item?: TranscriptItem; partial: boolean } {
  const whole = contextText(undefined, row.payload);
  const text = whole.slice(0, full ? 256 * 1024 : 4000);
  const id = recordId(row, ref.offset), timestamp = Date.parse(row.timestamp);
  return { partial: false, item: {
    eventId: `codex:${ref.nativeSessionId}:${id}`, type: "message", role: "context", content: text,
    ...(Number.isFinite(timestamp) ? { createdAt: timestamp } : {}),
    data: { source: "transcript", nativeMessageId: id, parentId: null,
      parts: [{ type: "context", text, context: { kind: "world_state", tier: "collapsed", length: whole.length } }],
      truncated: text.length < whole.length, detail: { ...ref, recordId: id } },
  } };
}

function normalize(row: Record<string, any>, ref: TranscriptItem["data"]["detail"], full = false): { item?: TranscriptItem; partial: boolean } {
  if (row.type === "session_meta" || row.type === "turn_context") return { partial: false };
  // response_item is canonical. event_msg mirrors never become second copies,
  // including when the two records land in different incremental batches.
  if (row.type === "event_msg") return { partial: ![
    "user_message", "agent_message", "agent_reasoning", "token_count", "task_started", "task_complete", "turn_aborted"
  ].includes(row.payload?.type) };
  if (row.type === "world_state" && object(row.payload)) return worldState(row, ref, full);
  if (row.type !== "response_item" || !object(row.payload)) return { partial: true };
  const p = row.payload, parts: TranscriptItem["data"]["parts"] = [];
  let role = "assistant", truncated = false, partial = false, total = 0;
  const toolOutput = ["function_call_output", "custom_tool_call_output"].includes(p.type);
  const limit = full ? 256 * 1024 : toolOutput ? 4000 : 64 * 1024;
  function add(type: string, text: string, extra = {}) {
    const output = text.slice(0, Math.max(0, limit - total)); total += output.length;
    truncated ||= output.length < text.length; parts.push({type, text: output, ...extra});
  }
  if (p.type === "message") {
    if (!["user", "assistant", "system", "developer"].includes(p.role) || !Array.isArray(p.content)) return {partial: true};
    role = p.role === "developer" ? "system" : p.role;
    if (p.content.length > 512) { partial = true; truncated = true; }
    for (const block of p.content.slice(0, 512)) {
      if (object(block) && ["input_text", "output_text", "text"].includes(block.type) && typeof block.text === "string") add("text", block.text);
      else { partial = true; add("unsupported", "[未支持的记录内容]"); }
    }
  } else if (["function_call", "custom_tool_call"].includes(p.type)) {
    if (typeof p.call_id !== "string" || typeof p.name !== "string") return {partial: true};
    const raw = p.type === "function_call" ? p.arguments : p.input;
    // codex 把 function_call 的参数存成 JSON 字符串，custom_tool_call 的 input 则是自由文本。
    // 预览态：解得回对象的按结构截断，解不回的仍当一段文本——它本来就不是一份参数对象。
    const parsed = typeof raw === "string" ? parseArgs(raw) : raw;
    const args = full ? {text: typeof raw === "string" ? raw : JSON.stringify(raw ?? {}), truncated: false}
      : typeof parsed === "string" ? previewToolText(parsed) : previewToolArgs(parsed);
    truncated ||= args.truncated;
    add("tool_call", `${p.name}: ${args.text}`, {toolCallId: p.call_id, name: p.name});
  } else if (toolOutput) {
    if (typeof p.call_id !== "string") return {partial: true};
    role = "tool";
    add("tool_result", typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""), {toolCallId: p.call_id});
  } else if (p.type === "reasoning") {
    // Only the recorded summary is public text; encrypted_content is never exposed.
    if (!Array.isArray(p.summary)) return {partial: true};
    if (p.summary.length > 512) { partial = true; truncated = true; }
    for (const block of p.summary.slice(0, 512)) {
      if (object(block) && typeof block.text === "string" && block.type === "summary_text") add("thinking", block.text);
      else partial = true;
    }
    if (!parts.length) return {partial};
  } else return {partial: true};
  const id = recordId(row, ref.offset), timestamp = Date.parse(row.timestamp);
  return {partial, item: {
    eventId: `codex:${ref.nativeSessionId}:${id}`, type: "message", role,
    content: parts.map(part => part.text ?? "").join("\n"),
    ...(Number.isFinite(timestamp) ? {createdAt: timestamp} : {}),
    data: {source: "transcript", nativeMessageId: id, parentId: null, parts, truncated, detail: {...ref, recordId: id}}
  }};
}

/** Read at most one byte budget per call, committing partial UTF-8/JSON bytes via checkpoint. */
export async function readCodexTranscript(path: string, nativeId: string, previous?: TranscriptCheckpoint) {
  if (!isAbsolute(path)) throw new TranscriptError("absolute_path_required");
  const canonical = await realpath(path);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TranscriptError("not_file");
    await header(handle, nativeId);
    const identity = fingerprint(stat);
    let reset = !previous || previous.adapter !== "codex-rollout" || previous.path !== canonical || previous.fingerprint !== identity || stat.size < previous.offset || (previous?.mtimeMs !== undefined && previous.mtimeMs !== stat.mtimeMs && stat.size <= previous.fileSize);
    if (!reset && previous!.tail) {
      const tail = Buffer.from(previous!.tail, "base64"), check = Buffer.alloc(tail.length);
      await handle.read(check, 0, check.length, previous!.offset - tail.length);
      if (!tail.equals(check)) reset = true;
    }
    const state: TranscriptCheckpoint = reset
      ? { path: canonical, fingerprint: identity, offset: 0, pending: "", discarding: false, tail: "", fileSize: stat.size, skipped: 0, active: true, status: "reading" }
      : { ...previous!, active: true, reason: undefined, fileSize: stat.size };
    state.adapter = "codex-rollout";
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
          if (row.type === "session_meta" && row.payload?.id !== nativeId) throw new TranscriptError("session_mismatch");
          const ref = { provider: "codex", path: canonical, fingerprint: identity, offset: base + start,
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

export async function readCodexDetail(ref: TranscriptItem["data"]["detail"]) {
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
    if (recordId(row, ref.offset) !== ref.recordId) throw new TranscriptError("file_changed");
    return normalize(row, ref, true).item;
  } finally { await handle.close(); }
}
