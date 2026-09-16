import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TranscriptError, type TranscriptCheckpoint, type TranscriptItem } from "./index.ts";
import { previewToolArgs, previewToolText } from "./truncate.ts";
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
function normalize(row: Record<string, any>, ref: TranscriptItem["data"]["detail"], full = false): { item?: TranscriptItem; partial: boolean } {
  if (row.type === "session_meta" || row.type === "turn_context") return { partial: false };
  // response_item is canonical. event_msg mirrors never become second copies,
  // including when the two records land in different incremental batches.
  if (row.type === "event_msg") return { partial: ![
    "user_message", "agent_message", "agent_reasoning", "token_count", "task_started", "task_complete", "turn_aborted"
  ].includes(row.payload?.type) };
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
    /*
      codex 把 `<environment_context>` 这类机器注入写成**普通 user 消息**，和真人说的话
      在记录里长得一模一样。本机实测一份转录 12 条 user 里有 3 条是注入——照原样画出来，
      界面就会显示成「你说过这些」，而你从没说过。

      判据不是字符串匹配，是 **codex 自己打的标**：
      `payload.internal_chat_message_metadata_passthrough.content_item_kinds`，
      真人那条是 `["user.text"]`，注入那条是 `["environments.environment_context"]`。
      实测那份转录 12/12 都有这个字段。

      **字段缺失时不猜**：那一版没打标，就照原样当用户文本处理。宁可漏标，不可错标——
      把真人说的话标成机器注入，比反过来更糟。

      **只在整条消息都是机器项时才算注入**：`content_item_kinds` 与 `content` 是否逐项
      对齐没有验证过，混合的情况下按项拆分就是猜。样本里两个数组长度都是 1。

      字段名自带 `internal_..._passthrough`，是供应商内部结构，可能会变——所以它只是
      一个加分项，拿不到就退回原行为，不会让解析失败。
    */
    const meta = object(p.internal_chat_message_metadata_passthrough) ? p.internal_chat_message_metadata_passthrough : undefined;
    const kinds = Array.isArray(meta?.content_item_kinds) ? meta.content_item_kinds : undefined;
    const injected = role === "user" && !!kinds?.length
      && kinds.every((kind: unknown) => typeof kind === "string" && !kind.startsWith("user."));
    for (const block of p.content.slice(0, 512)) {
      if (object(block) && ["input_text", "output_text", "text"].includes(block.type) && typeof block.text === "string") {
        if (injected) add("context", block.text, { contextLabel: kinds!.join(", ") });
        else add("text", block.text);
      }
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
    // 注入不进 content：那个字段是预览取的、搜索扫的。混进去会让目录里这条对话的预览
    // 显示成一段 <environment_context>，也会让搜索在用户从没写过的词上命中他的消息。
    // 一个字都没丢——它在 parts 里。
    content: parts.filter(part => part.type !== "context").map(part => part.text ?? "").join("\n"),
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
