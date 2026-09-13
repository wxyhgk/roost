import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceStore } from '@roost/workspace-store';
import { readJson, sendError } from './http';

/**
 * 收藏面板的读写。
 *
 * 卡片存的是**快照**（cliId + nativeSessionId + cwd + 标题），不是指向对话库某一行的引用
 * ——这个面板要活得比它记录的东西久。恢复命令由前端按 cliId 拼（`resumeArgv` 那套），
 * 后端只负责把这几样存住。
 */
const MAX_TEXT = 4096;
function text(value: unknown, name: string, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > MAX_TEXT)
    throw new Error(`${name} 必须是 1..${MAX_TEXT} 个字符`);
  return value;
}
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${name} 不是合法 ID`);
  return value;
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleBookmarks(
  req: IncomingMessage, res: ServerResponse, url: URL, store: WorkspaceStore,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/bookmarks')) return false;
  const marks = store.bookmarks;
  const body = async () => await readJson(req) as Record<string, unknown>;
  try {
    if (path === '/api/bookmarks' && req.method === 'GET') { json(res, 200, marks.list()); return true; }
    const history = path.match(/^\/api\/bookmarks\/([^/]+)\/conversation$/);
    if (history && req.method === 'GET') {
      const id = identifier(decodeURIComponent(history[1]), 'id');
      const card = marks.list().cards.find(item => item.id === id);
      if (!card) { sendError(res, 404, 'not_found', '收藏不存在'); return true; }
      json(res, 200, store.conversations.findBySource(card.cliId, card.nativeSessionId));
      return true;
    }
    if (path === '/api/bookmarks' && req.method === 'POST') {
      const b = await body();
      json(res, 201, marks.add({
        id: identifier(b.id, 'id'), cliId: identifier(b.cliId, 'cliId'),
        nativeSessionId: identifier(b.nativeSessionId, 'nativeSessionId'),
        cwd: b.cwd == null ? null : text(b.cwd, 'cwd'),
        title: text(b.title, 'title'),
        note: b.note == null ? null : text(b.note, 'note', false),
        groupId: b.groupId == null ? null : identifier(b.groupId, 'groupId'),
      }));
      return true;
    }
    if (path === '/api/bookmarks/groups' && req.method === 'POST') {
      const b = await body();
      json(res, 201, marks.addGroup(identifier(b.id, 'id'), text(b.name, 'name')));
      return true;
    }
    const group = path.match(/^\/api\/bookmarks\/groups\/([^/]+)$/);
    if (group) {
      const id = identifier(decodeURIComponent(group[1]), 'id');
      if (req.method === 'PATCH') {
        const b = await body();
        if ('beforeId' in b) marks.reorderGroup(id, b.beforeId == null ? null : identifier(b.beforeId, 'beforeId'));
        if ('name' in b) marks.renameGroup(id, text(b.name, 'name'));
        json(res, 200, marks.list()); return true;
      }
      if (req.method === 'DELETE') { marks.removeGroup(id); json(res, 200, marks.list()); return true; }
    }
    const card = path.match(/^\/api\/bookmarks\/([^/]+)$/);
    if (card) {
      const id = identifier(decodeURIComponent(card[1]), 'id');
      if (req.method === 'PATCH') {
        const b = await body();
        if ('beforeId' in b) marks.reorderCard(id, b.beforeId == null ? null : identifier(b.beforeId, 'beforeId'));
        const patch: { title?: string; note?: string | null; groupId?: string | null } = {};
        if ('title' in b) patch.title = text(b.title, 'title');
        if ('note' in b) patch.note = b.note == null ? null : text(b.note, 'note', false);
        if ('groupId' in b) patch.groupId = b.groupId == null ? null : identifier(b.groupId, 'groupId');
        if (Object.keys(patch).length && !marks.update(id, patch)) { sendError(res, 404, 'not_found', '收藏不存在'); return true; }
        json(res, 200, marks.list()); return true;
      }
      if (req.method === 'DELETE') { marks.remove(id); json(res, 200, marks.list()); return true; }
    }
    sendError(res, 405, 'method_not_allowed', '不支持这个方法');
    return true;
  } catch (error) {
    sendError(res, 400, 'invalid_request', error instanceof Error ? error.message : '请求无效');
    return true;
  }
}
