import { createHash } from 'node:crypto';
import { TranscriptError } from './index.js';

export type OpenCodeNativeStatus = 'idle' | 'busy' | 'retry' | 'unknown';
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A missing map entry is not proof that the attached TUI composer is empty. */
export function parseOpenCodeStatus(value: unknown, nativeId: string): OpenCodeNativeStatus {
  if (!object(value) || !Object.hasOwn(value, nativeId)) return 'unknown';
  const status = value[nativeId];
  return object(status) && ['idle', 'busy', 'retry'].includes(status.type) ? status.type : 'unknown';
}

/** Server identity, not TUI identity: callers still need an authenticated terminal binding. */
export function openCodeSessionIdentity(endpoint: string, nativeId: string, session: unknown): string {
  if (!object(session) || session.id !== nativeId) throw new TranscriptError('session_mismatch');
  if (!object(session.time) || !Number.isFinite(session.time.created)) throw new TranscriptError('unsupported_session');
  return createHash('sha256').update(JSON.stringify([endpoint, nativeId, session.time.created, session.directory, session.projectID])).digest('hex');
}

/** Exact native receipt matching. HTTP 204 or equal text from another message is not a receipt. */
export function isOpenCodeUserReceipt(value: unknown, nativeId: string, messageId: string, text: string): boolean {
  if (!object(value) || !object(value.info) || value.info.id !== messageId || value.info.sessionID !== nativeId ||
      value.info.role !== 'user' || !Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > 512) return false;
  const normalize = (input: string) => input.replace(/\r\n/g, '\n');
  const parts: string[] = [];
  for (const part of value.parts) {
    if (!object(part) || part.type !== 'text' || typeof part.text !== 'string' || part.synthetic === true || part.ignored === true ||
        (part.sessionID !== undefined && part.sessionID !== nativeId) || (part.messageID !== undefined && part.messageID !== messageId)) return false;
    parts.push(part.text);
  }
  return normalize(parts.join('')) === normalize(text);
}
