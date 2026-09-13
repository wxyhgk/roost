import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConversationError, type ConversationsStore } from '@roost/workspace-store';
import { AiHistoryError } from '@roost/ai-session-bridge';
import { HttpInputError, readJson } from './http';

const MAX_LIMIT = 200;
const MAX_TEXT = 200;
const PATCH_BYTES = 16 * 1024;
const states = ['active', 'archived', 'trashed', 'all'] as const;

function invalid(message: string): never { throw new ConversationError(400, 'invalid_request', message); }

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid(`${name}: valid ID required`);
  }
  return value;
}

function pathIdentifier(raw: string, name: string): string {
  let value: string;
  try { value = decodeURIComponent(raw); } catch { return invalid(`${name}: invalid encoded ID`); }
  return identifier(value, name);
}

function queryKeys(params: URLSearchParams, allowed: readonly string[]) {
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid('invalid or repeated query parameter');
  }
}

function pageOptions(params: URLSearchParams): { cursor?: string; limit?: number } {
  const options: { cursor?: string; limit?: number } = {};
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    const value = Number(rawLimit);
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(value) || value > MAX_LIMIT) {
      invalid(`limit: integer between 1 and ${MAX_LIMIT} required`);
    }
    options.limit = value;
  }
  const cursor = params.get('cursor');
  if (cursor !== null) {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid('invalid cursor');
    options.cursor = cursor;
  }
  return options;
}

function listOptions(params: URLSearchParams): Parameters<ConversationsStore['list']>[0] {
  queryKeys(params, ['projectId', 'terminalId', 'q', 'state', 'sort', 'cursor', 'limit']);
  const options: NonNullable<Parameters<ConversationsStore['list']>[0]> = pageOptions(params);
  const sort = params.get('sort');
  if (sort !== null) {
    if (sort !== 'activity' && sort !== 'created') invalid('invalid sort');
    options.sort = sort;
  }
  const terminalId = params.get('terminalId');
  if (terminalId !== null) options.terminalId = identifier(terminalId, 'terminalId');
  const projectId = params.get('projectId');
  if (projectId !== null) options.projectId = projectId === 'null' ? null : identifier(projectId, 'projectId');
  const q = params.get('q');
  if (q !== null) {
    if (q.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(q)) invalid(`q: text up to ${MAX_TEXT} characters required`);
    options.q = q;
  }
  const state = params.get('state');
  if (state !== null) {
    if (!states.includes(state as typeof states[number])) invalid('invalid state');
    options.state = state as typeof states[number];
  }
  return options;
}

function patchFields(body: Record<string, unknown>): Parameters<ConversationsStore['patch']>[1] {
  const allowed = ['revision', 'title', 'projectId', 'archived', 'trashed', 'pinned'];
  for (const key of Object.keys(body)) if (!allowed.includes(key)) invalid(`body.${key}: unknown field`);
  if (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 1 || body.revision >= Number.MAX_SAFE_INTEGER) {
    invalid('revision: positive safe integer required');
  }
  const patch: Parameters<ConversationsStore['patch']>[1] = { revision: body.revision as number };
  if (Object.hasOwn(body, 'title')) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(body.title)) {
      invalid(`title: nonempty text up to ${MAX_TEXT} characters required`);
    }
    patch.title = (body.title as string).trim();
  }
  if (Object.hasOwn(body, 'projectId')) patch.projectId = body.projectId === null ? null : identifier(body.projectId, 'projectId');
  for (const key of ['archived', 'trashed', 'pinned'] as const) {
    if (!Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== 'boolean') invalid(`${key}: boolean required`);
    patch[key] = body[key] as boolean;
  }
  if (Object.keys(patch).length === 1) invalid('at least one metadata field required');
  return patch;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Catalog and saved history only: reading never starts a CLI or reads its native files. */
export async function handleConversations(
  req: IncomingMessage, res: ServerResponse, url: URL, store?: ConversationsStore,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/conversations(?:\/([^/]+)(?:\/(messages|runs)(?:\/([^/]+))?)?)?$/);
  if (!match) return false;
  if (match[2] === 'runs' && match[3] !== undefined) return false;
  try {
    const id = match[1] === undefined ? undefined : pathIdentifier(match[1], 'conversationId');
    const messages = match[2] !== undefined;
    const messageId = match[3] === undefined ? undefined : pathIdentifier(match[3], 'messageId');
    const allowed = id !== undefined && !messages ? ['GET', 'PATCH'] : ['GET'];
    if (!allowed.includes(req.method ?? '')) {
      res.setHeader('allow', allowed.join(', '));
      throw new ConversationError(405, 'method_not_allowed', 'method not allowed');
    }
    if (id === undefined) {
      const options = listOptions(url.searchParams);
      if (!store) throw new ConversationError(503, 'storage_unavailable', 'conversation storage unavailable');
      json(res, 200, store.list(options));
    } else if (match[2] === 'runs') {
      queryKeys(url.searchParams, ['terminalId', 'cursor', 'limit']);
      const options: Parameters<ConversationsStore['listRuns']>[1] = pageOptions(url.searchParams);
      const terminalId = url.searchParams.get('terminalId');
      if (terminalId !== null) options.terminalId = identifier(terminalId, 'terminalId');
      if (!store) throw new ConversationError(503, 'storage_unavailable', 'conversation storage unavailable');
      json(res, 200, store.listRuns(id, options));
    } else if (messages && messageId === undefined) {
      queryKeys(url.searchParams, ['cursor', 'limit']);
      const options = pageOptions(url.searchParams);
      if (!store) throw new ConversationError(503, 'storage_unavailable', 'conversation storage unavailable');
      json(res, 200, store.pageMessages(id, options));
    } else {
      queryKeys(url.searchParams, []);
      const patch = req.method === 'PATCH' ? patchFields(await readJson(req, PATCH_BYTES)) : undefined;
      if (!store) throw new ConversationError(503, 'storage_unavailable', 'conversation storage unavailable');
      json(res, 200, patch !== undefined ? store.patch(id, patch) : messageId !== undefined ? store.getMessage(id, messageId) : store.get(id));
    }
  } catch (error) {
    if (error instanceof ConversationError) {
      json(res, error.status, { error: { code: error.code, message: error.message }, ...(error.current === undefined ? {} : { current: error.current }) });
    } else if (error instanceof AiHistoryError) {
      json(res, error.status, { error: { code: error.code, message: error.message } });
    } else if (error instanceof HttpInputError) {
      json(res, error.status, { error: { code: error.status === 413 ? 'too_large' : 'invalid_request', message: error.message } });
    } else {
      json(res, 503, { error: { code: 'storage_unavailable', message: 'conversation storage temporarily unavailable; retry later' } });
    }
  }
  return true;
}
