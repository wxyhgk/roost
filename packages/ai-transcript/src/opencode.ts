import { createHash } from 'node:crypto';
import { TranscriptError, type TranscriptCheckpoint, type TranscriptItem } from './index.js';
import { openCodeSessionIdentity, parseOpenCodeStatus, type OpenCodeNativeStatus } from './opencode-control.js';

const LIMIT = 100, BODY_LIMIT = 4 * 1024 * 1024;
type State = TranscriptCheckpoint & { adapter: 'opencode-api'; state: { snapshotHash: string; sessionIdentity: string; coverage: 'bounded_snapshot'; nativeStatus: OpenCodeNativeStatus } };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Read an explicitly bound existing server. Never starts a second server or discovers sessions. */
export async function readOpenCodeTranscript(endpoint: string, nativeId: string, previous?: TranscriptCheckpoint) {
  let base: URL;
  try { base = new URL(endpoint); } catch { throw new TranscriptError('invalid_endpoint'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hash ||
      [...base.searchParams.keys()].some(key => key !== 'directory') || !/^[a-zA-Z0-9_-]{1,256}$/.test(nativeId))
    throw new TranscriptError('invalid_endpoint');
  const path = base.toString(), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let bytesRead = 0;
  async function get(route: string, limit?: number): Promise<any> {
    const url = new URL(base); url.pathname = base.pathname.replace(/\/$/, '') + route;
    if (limit) url.searchParams.set('limit', String(limit));
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new TranscriptError(response.status === 404 ? 'session_unavailable' : 'upstream_unavailable'); }
    if (Number(response.headers.get('content-length')) > BODY_LIMIT) { await response.body?.cancel(); throw new TranscriptError('response_too_large'); }
    const reader = response.body?.getReader(); if (!reader) throw new TranscriptError('invalid_response');
    const buffers: Uint8Array[] = [];
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytesRead += part.value.length;
      if (bytesRead > BODY_LIMIT) { await reader.cancel(); throw new TranscriptError('response_too_large'); } buffers.push(part.value); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new TranscriptError('invalid_response'); }
  }
  try {
    const session = await get('/session/' + encodeURIComponent(nativeId));
    // Creation identity detects endpoint reuse with a different session using the same ID.
    const sessionIdentity = openCodeSessionIdentity(path, nativeId, session);
    const old = previous as State | undefined;
    if (old?.adapter === 'opencode-api' && old.path === path && old.state?.sessionIdentity !== sessionIdentity)
      throw new TranscriptError('session_identity_changed');
    const rows = await get('/session/' + encodeURIComponent(nativeId) + '/message', LIMIT);
    if (!Array.isArray(rows) || rows.length > LIMIT) throw new TranscriptError('unsupported_message_limit');
    const items: TranscriptItem[] = [], details: TranscriptItem[] = [];
    let skipped = rows.length === LIMIT ? 1 : 0;
    const ids = new Set<string>();
    for (const row of rows) {
      if (!object(row) || !object(row.info) || row.info.sessionID !== nativeId) throw new TranscriptError('session_mismatch');
      const info = row.info;
      if (typeof info.id !== 'string' || !info.id || info.id.length > 256 || ids.has(info.id)) throw new TranscriptError('invalid_message');
      ids.add(info.id);
      if (!['user', 'assistant'].includes(info.role) || !Array.isArray(row.parts)) { skipped++; continue; }
      const parts: TranscriptItem['data']['parts'] = [];
      let partial = row.parts.length > 512;
      for (const p of row.parts.slice(0, 512)) {
        if (!object(p)) { partial = true; continue; }
        if (p.sessionID !== undefined && p.sessionID !== nativeId || p.messageID !== undefined && p.messageID !== info.id)
          throw new TranscriptError('session_mismatch');
        if ((p.type === 'text' || p.type === 'reasoning') && typeof p.text === 'string')
          parts.push({ type: p.type === 'reasoning' ? 'thinking' : 'text', text: p.text });
        else if (p.type === 'tool' && typeof p.tool === 'string' && object(p.state)) {
          const toolCallId = typeof p.callID === 'string' ? p.callID : undefined;
          parts.push({ type: 'tool_call', name: p.tool, toolCallId, text: JSON.stringify(p.state.input ?? {}) });
          if (p.state.status === 'completed') parts.push({ type: 'tool_result', name: p.tool, toolCallId, text: typeof p.state.output === 'string' ? p.state.output : '' });
          else if (p.state.status === 'error') parts.push({ type: 'tool_error', name: p.tool, toolCallId, text: typeof p.state.error === 'string' ? p.state.error : '' });
          else if (!['pending', 'running'].includes(p.state.status)) partial = true;
        } else if (!['step-start', 'step-finish'].includes(p.type)) { partial = true; parts.push({ type: 'unsupported', text: '[未支持的记录内容]' }); }
      }
      if (partial) skipped++;
      const revision = hash({ info, parts: row.parts });
      function normalize(limit: number): TranscriptItem {
        let remaining = limit, truncated = partial;
        const bounded = parts.map(p => { const text = (p.text ?? '').slice(0, remaining); remaining -= text.length; truncated ||= text.length < (p.text ?? '').length; return { ...p, text }; });
        return { eventId: `opencode:${nativeId}:${info.id}`, type: 'message', role: info.role,
          ...(Number.isFinite(info.time?.created) ? { createdAt: info.time.created } : {}),
          content: bounded.map(p => p.text ?? '').join('\n'), data: { source: 'transcript', nativeMessageId: info.id,
            parentId: typeof info.parentID === 'string' ? info.parentID : null, parts: bounded, truncated,
            detail: { path, fingerprint: sessionIdentity, offset: 0, length: 0, nativeSessionId: nativeId, recordId: info.id, hash: revision } } };
      }
      items.push(normalize(64000)); details.push(normalize(256000));
    }
    // Status is supplemental: older or temporarily failing servers must not hide readable messages.
    let nativeStatus: OpenCodeNativeStatus = 'unknown';
    try { nativeStatus = parseOpenCodeStatus(await get('/session/status'), nativeId); } catch { /* keep the successful transcript */ }
    const snapshotHash = hash([items, skipped]);
    const reset = old?.adapter !== 'opencode-api' || old.path !== path || old.state?.snapshotHash !== snapshotHash;
    const checkpoint: State = { path, fingerprint: sessionIdentity, offset: 0, fileSize: 0, pending: '', tail: '', discarding: false,
      active: true, skipped, status: skipped ? 'partial' : 'caught_up', reason: 'bounded_snapshot', adapter: 'opencode-api',
      state: { snapshotHash, sessionIdentity, coverage: 'bounded_snapshot', nativeStatus } };
    return { checkpoint, items: reset ? items : [], details: reset ? details : [], reset, bytesRead: reset ? bytesRead : 0 };
  } catch (error) { if (error instanceof TranscriptError) throw error; throw new TranscriptError(controller.signal.aborted ? 'upstream_timeout' : 'upstream_unavailable'); }
  finally { clearTimeout(timeout); }
}
