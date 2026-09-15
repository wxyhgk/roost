import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { TranscriptError, type TranscriptCheckpoint, type TranscriptItem } from './index.ts';
import { previewToolArgs, previewToolText } from './truncate.ts';
const BATCH = 256 * 1024, LINE = 1024 * 1024;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function fingerprint(stat: {dev:number;ino:number;birthtimeMs:number}) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
async function header(handle: Awaited<ReturnType<typeof open>>, nativeId: string) {
  if (!/^[a-zA-Z0-9_-]{1,512}$/.test(nativeId)) throw new TranscriptError('invalid_native_id');
  const buffer = Buffer.alloc(LINE + 1);
  const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
  const end = buffer.subarray(0, bytesRead).indexOf(10);
  if (end < 0) throw new TranscriptError('header_unavailable');
  let row; try { row = JSON.parse(buffer.subarray(0,end).toString('utf8')); } catch { throw new TranscriptError('header_unavailable'); }
  if (!['session/update','_x.ai/session/update'].includes(row?.method)) throw new TranscriptError('unsupported_format');
  if (row.params?.sessionId !== nativeId) throw new TranscriptError('session_mismatch');
}

/** Search only caller-authorized session roots; never select the newest unrelated session. */
export async function discoverGrokTranscript(nativeId: string, roots: string[]): Promise<string|null> {
  if (!/^[a-zA-Z0-9_-]{1,512}$/.test(nativeId)) throw new TranscriptError('invalid_native_id');
  let count = 0; const matches = new Set<string>();
  for (const root of roots) {
    let projects; try { projects = await opendir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for await (const project of projects) {
      if (++count > 10000) throw new TranscriptError('discovery_limit');
      if (!project.isDirectory()) continue;
      const path = join(root, project.name, nativeId, 'updates.jsonl');
      try { const resolved = await realpath(path); const handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
        try { if ((await handle.stat()).isFile()) { await header(handle,nativeId); matches.add(resolved); } } finally { await handle.close(); }
      } catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    }
  }
  if (matches.size > 1) throw new TranscriptError('ambiguous_transcript');
  return [...matches][0] ?? null;
}

/** Grok Build 1.0.13 stores ACP notifications with native event IDs in updates.jsonl.
 * These are recorded chunks, not fabricated whole assistant turns. */
function normalize(row: Record<string, any>, ref: TranscriptItem['data']['detail'], full = false): {item?:TranscriptItem;partial:boolean} {
  const p = row.params, update = p?.update;
  if (!object(p) || p.sessionId !== ref.nativeSessionId) throw new TranscriptError('session_mismatch');
  if (!object(update)) return {partial:true};
  if (row.method !== 'session/update') return {partial:true};
  const id = p._meta?.eventId;
  if (typeof id !== 'string' || !id || id.length > 512) return {partial:true};
  const parts: TranscriptItem['data']['parts'] = [];
  let role = 'assistant', partial = false, truncated = false, remaining = full ? 256*1024 : 64*1024;
  function add(type:string,text:string,extra = {}) { const bounded = text.slice(0,remaining); remaining -= bounded.length; truncated ||= bounded.length !== text.length; parts.push({type,text:bounded,...extra}); }
  if (['user_message_chunk','agent_message_chunk','agent_thought_chunk'].includes(update.sessionUpdate)) {
    role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
    if (update.content?.type !== 'text' || typeof update.content.text !== 'string') return {partial:true};
    add(update.sessionUpdate === 'agent_thought_chunk' ? 'thinking' : 'text', update.content.text);
  } else if (['tool_call','tool_call_update'].includes(update.sessionUpdate)) {
    if (typeof update.toolCallId !== 'string' || !update.toolCallId || update.toolCallId.length > 512) return {partial:true};
    /*
      `name` 是前端用来对号入座渲染器的键（frontend/src/features/conversations/tools/identify.ts
      → registry.tsx），所以只能放工具身份，不能放人话标题。

      **ACP 的 tool_call 里没有 `Bash` / `apply_patch` 那种具体工具名**：协议只给 `kind`
      （read / edit / execute / search / fetch / think / other 这几个类别）、一句给人看的
      `title`、以及 `rawInput`。grok 走的就是标准 ACP（见 tasks/cli-adapters/grok.md），
      happier 对 grok 也是拿 `kind` 当工具名的（它给 gemini/opencode/codex 那几家实现了
      extractToolNameFromId，唯独 grok 没有，于是回落到 kind）。

      于是这里写 `kind`：它是这条记录里唯一机器可读的身份，而且 identify.ts 的别名表本来就
      认得它——execute→bash、search→grep、view→read 这几条就是从 happier 的 ACP 归一化搬来的。
      title 不再进 `name`：它是「Read sanitized-001.txt」这种句子，既匹配不上任何渲染器，
      又会让摘要行上本该显示工具名的位置变成一整句话。kind 缺失时宁可不给名字，不编一个。
    */
    const kind = typeof update.kind === 'string' && update.kind.trim() ? update.kind.trim().slice(0,512) : undefined;
    const extra = {toolCallId:update.toolCallId, ...(kind ? {name:kind} : {})};
    /*
      正文拼成 `name: 参数`，和另外六家一致——`parts.ts` 的 toolArgs 靠这个前缀把参数剥出来，
      剥出来得是可解析的 JSON，渲染器才拿得到字段。原来另起了一种 `tool_input` part，
      而 parts.ts 只认 tool_call / tool_result / tool_error，它会掉进通用文本分支，
      把一串 JSON 参数当成聊天气泡画出来。预览态按结构截断，详情态给完整 JSON。

      没有 rawInput 时退回 title（ACP 允许只发标题不发参数）：那时它是这条记录里唯一说得清
      「干了什么」的东西，比一个空的 `{}` 有用。它不是 JSON，前端解不出对象就按原文显示。
    */
    const args = update.rawInput === undefined && typeof update.title === 'string'
      ? (full ? {text:update.title,truncated:false} : previewToolText(update.title))
      : (full ? {text:JSON.stringify(update.rawInput ?? {}),truncated:false} : previewToolArgs(update.rawInput));
    truncated ||= args.truncated;
    add('tool_call',kind ? `${kind}: ${args.text}` : args.text,extra);
    if (Array.isArray(update.content)) {
      if (update.content.length > 512) partial = true;
      for (const block of update.content.slice(0,512)) {
        if (block?.type === 'content' && block.content?.type === 'text' && typeof block.content.text === 'string') add(update.status === 'failed' ? 'tool_error' : 'tool_result',block.content.text,extra);
        else partial = true;
      }
    }
    if (update.rawOutput !== undefined) add(update.status === 'failed' ? 'tool_error' : 'tool_result', typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput),extra);
  } else return {partial:!['available_commands_update','current_mode_update','config_option_update','session_info_update','usage_update','plan'].includes(update.sessionUpdate)};
  const createdAt = Number.isFinite(p._meta?.agentTimestampMs) ? p._meta.agentTimestampMs : Number.isFinite(row.timestamp) ? row.timestamp*1000 : undefined;
  return {partial,item:{eventId:`grok:${ref.nativeSessionId}:${id}`,type:'message',role,content:parts.map(p=>p.text??'').join('\n'),
    ...(createdAt !== undefined ? {createdAt} : {}),data:{source:'transcript',nativeMessageId:id,parentId:null,parts,truncated:truncated||partial,detail:{...ref,recordId:id}}}};
}

/** Read at most one byte budget per call, committing partial UTF-8/JSON bytes via checkpoint. */
export async function readGrokTranscript(path: string, nativeId: string, previous?: TranscriptCheckpoint) {
  if (!isAbsolute(path)) throw new TranscriptError("absolute_path_required");
  const canonical = await realpath(path);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TranscriptError("not_file");
    await header(handle, nativeId);
    const identity = fingerprint(stat);
    let reset = !previous || previous.adapter !== "grok-acp-updates" || previous.path !== canonical || previous.fingerprint !== identity || stat.size < previous.offset || (previous?.mtimeMs !== undefined && previous.mtimeMs !== stat.mtimeMs && stat.size <= previous.fileSize);
    if (!reset && previous!.tail) {
      const tail = Buffer.from(previous!.tail, "base64"), check = Buffer.alloc(tail.length);
      await handle.read(check, 0, check.length, previous!.offset - tail.length);
      if (!tail.equals(check)) reset = true;
    }
    const state: TranscriptCheckpoint = reset
      ? { path: canonical, fingerprint: identity, offset: 0, pending: "", discarding: false, tail: "", fileSize: stat.size, skipped: 0, active: true, status: "reading" }
      : { ...previous!, active: true, reason: undefined, fileSize: stat.size };
    state.adapter = "grok-acp-updates";
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
          if (row.params?.sessionId !== nativeId) throw new TranscriptError("session_mismatch");
          const ref = { provider: "grok", path: canonical, fingerprint: identity, offset: base + start,
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
