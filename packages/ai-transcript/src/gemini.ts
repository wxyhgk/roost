import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TranscriptError, type TranscriptCheckpoint, type TranscriptItem } from './index.ts';

const LIMIT = 4 * 1024 * 1024, MAX_MESSAGES = 2000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Gemini rewrites a JSON conversation, so offsets cannot safely tail it. Read a bounded,
 * identity-checked snapshot; the durable store applies stable message IDs as revisions. */
export async function readGeminiTranscript(inputPath: string, nativeId: string, previous?: TranscriptCheckpoint) {
  if (!isAbsolute(inputPath) || !/^[a-zA-Z0-9_-]{1,512}$/.test(nativeId)) throw new TranscriptError('invalid_transcript');
  const path = await realpath(inputPath);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new TranscriptError('not_regular_file');
    if (before.size > LIMIT) throw new TranscriptError('transcript_too_large');
    const buffer = Buffer.alloc(Math.min(LIMIT + 1, before.size + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytesRead !== before.size)
      throw new TranscriptError('transcript_changing');
    let session;
    try { session = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new TranscriptError('invalid_transcript'); }
    if (!object(session) || session.sessionId !== nativeId) throw new TranscriptError('session_mismatch');
    if (typeof session.projectHash !== 'string' || typeof session.startTime !== 'string' || !Number.isFinite(Date.parse(session.startTime)) || !Array.isArray(session.messages))
      throw new TranscriptError('unsupported_transcript');
    if (session.messages.length > MAX_MESSAGES) throw new TranscriptError('transcript_too_large');
    const identity = hash([nativeId, session.projectHash, session.startTime]);
    if (previous?.adapter === 'gemini-json' && previous.path === path && previous.state?.sessionIdentity !== identity)
      throw new TranscriptError('session_identity_changed');
    const items: TranscriptItem[] = [], details: TranscriptItem[] = [], ids = new Set<string>();
    let skipped = 0;
    for (const row of session.messages) {
      if (!object(row) || typeof row.id !== 'string' || !row.id || row.id.length > 512 || ids.has(row.id)) throw new TranscriptError('invalid_message');
      ids.add(row.id);
      if (!['user', 'gemini', 'info', 'error', 'warning'].includes(row.type)) { skipped++; continue; }
      let partial = false;
      const parts: TranscriptItem['data']['parts'] = [];
      function content(value: unknown, type = 'text', extra = {}) {
        const entries = Array.isArray(value) ? value : [value];
        if (entries.length > 512) partial = true;
        for (const entry of entries.slice(0, 512)) {
          if (typeof entry === 'string') parts.push({ type, text: entry, ...extra });
          else if (object(entry) && typeof entry.text === 'string') parts.push({ type, text: entry.text, ...extra });
          else if (object(entry) && object(entry.functionResponse)) parts.push({ type: 'tool_result', text: JSON.stringify(entry.functionResponse.response ?? {}), name: entry.functionResponse.name, ...extra });
          else { partial = true; parts.push({ type: 'unsupported', text: '[未支持的记录内容]' }); }
        }
      }
      content(row.content);
      if (Array.isArray(row.thoughts)) {
        if (row.thoughts.length > 512) partial = true;
        for (const thought of row.thoughts.slice(0, 512)) {
          if (object(thought) && typeof thought.description === 'string') parts.push({ type: 'thinking', text: (typeof thought.subject === 'string' ? thought.subject + '\n' : '') + thought.description });
          else partial = true;
        }
      }
      if (Array.isArray(row.toolCalls)) {
        if (row.toolCalls.length > 512) partial = true;
        for (const tool of row.toolCalls.slice(0, 512)) {
          if (!object(tool) || typeof tool.id !== 'string' || typeof tool.name !== 'string') { partial = true; continue; }
          const extra = { toolCallId: tool.id, name: tool.name };
          parts.push({ type: 'tool_call', text: JSON.stringify(tool.args ?? {}), ...extra });
          if (tool.result != null) content(tool.result, tool.status === 'error' ? 'tool_error' : 'tool_result', extra);
          if (!['validating', 'scheduled', 'executing', 'success', 'error', 'cancelled', 'awaiting_approval'].includes(tool.status)) partial = true;
        }
      }
      if (partial) skipped++;
      function normalize(limit: number): TranscriptItem {
        let remaining = limit, truncated = partial;
        const bounded = parts.map(part => {
          const text = (part.text ?? '').slice(0, remaining); remaining -= text.length;
          truncated ||= text.length !== (part.text ?? '').length; return { ...part, text };
        });
        const createdAt = Date.parse(row.timestamp);
        return { eventId: `gemini:${nativeId}:${row.id}`, type: 'message', role: row.type === 'gemini' ? 'assistant' : row.type === 'user' ? 'user' : 'system',
          ...(Number.isFinite(createdAt) ? { createdAt } : {}), content: bounded.map(part => part.text ?? '').join('\n'),
          data: { source: 'transcript', nativeMessageId: row.id, parentId: null, parts: bounded, truncated,
            detail: { provider: 'gemini', path, fingerprint: identity, offset: 0, length: bytesRead, nativeSessionId: nativeId, recordId: row.id, hash: hash(row) } } };
      }
      items.push(normalize(64 * 1024)); details.push(normalize(256 * 1024));
    }
    const snapshotHash = hash([items, skipped]);
    const reset = previous?.adapter !== 'gemini-json' || previous.path !== path || previous.state?.snapshotHash !== snapshotHash;
    const checkpoint: TranscriptCheckpoint = { adapter: 'gemini-json', path, fingerprint: identity,
      offset: 0, pending: '', discarding: false, tail: '', fileSize: bytesRead, mtimeMs: after.mtimeMs,
      skipped, active: true, status: skipped ? 'partial' : 'caught_up', reason: 'bounded_snapshot',
      state: { snapshotHash, sessionIdentity: identity, coverage: 'bounded_snapshot' } };
    return { checkpoint, items: reset ? items : [], details: reset ? details : [], reset, bytesRead };
  } finally { await handle.close(); }
}
