import type { IncomingMessage, ServerResponse } from 'node:http';
import { AiHistoryError, type HistoryStore } from '@roost/ai-session-bridge';

function invalid(message: string): never { throw new AiHistoryError(400, 'invalid_request', message); }
function identifier(raw: string): string {
  let value: string;
  try { value = decodeURIComponent(raw); } catch { return invalid('invalid encoded ID'); }
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return invalid('invalid ID');
  return value;
}
function positive(params: URLSearchParams, key: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum) return invalid(`${key}: positive integer up to ${maximum} required`);
  return value;
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Durable history does not depend on an active terminal or current bridge binding. */
export function handleAiHistory(req: IncomingMessage, res: ServerResponse, url: URL, history?: HistoryStore): boolean {
  const match = url.pathname.match(/^\/api\/ai-sessions\/([^/]+)\/generations(?:\/([^/]+)\/messages(?:\/([^/]+))?)?$/);
  if (!match) return false;
  try {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      throw new AiHistoryError(405, 'method_not_allowed', 'method not allowed');
    }
    const id = identifier(match[1]), generation = match[2] === undefined ? undefined : identifier(match[2]);
    const messageId = match[3] === undefined ? undefined : identifier(match[3]);
    const params = url.searchParams;
    const allowed = messageId !== undefined ? [] : generation !== undefined ? ['cursor', 'limit'] : ['beforeOrdinal', 'limit'];
    for (const key of params.keys()) {
      if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid('invalid or repeated query parameter');
    }
    const limit = positive(params, 'limit', 200);
    const beforeOrdinal = positive(params, 'beforeOrdinal');
    const cursor = params.get('cursor') ?? undefined;
    if (cursor !== undefined && (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor))) invalid('invalid cursor');
    if (!history) throw new AiHistoryError(503, 'storage_unavailable', 'AI history storage unavailable');
    const result = generation === undefined
      ? history.listGenerations(id, { beforeOrdinal, limit })
      : messageId === undefined
        ? history.pageMessages(id, generation, { cursor, limit })
        : history.getMessage(id, generation, messageId);
    json(res, 200, result);
  } catch (error) {
    if (error instanceof AiHistoryError) json(res, error.status, { error: { code: error.code, message: error.message } });
    else json(res, 503, { error: { code: 'storage_unavailable', message: 'AI history storage unavailable' } });
  }
  return true;
}
