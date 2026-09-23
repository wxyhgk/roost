import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConversationError, PeerMessageError, type WorkspaceStore } from '@roost/workspace-store';
import { HttpInputError, readJson } from './http';
import { createConversationStream } from './conversation-stream';

function invalid(message: string): never { throw new ConversationError(400, 'invalid_request', message); }
function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${name}: valid ID required`);
  return value as string;
}
function pathIdentifier(raw: string): string {
  try { return identifier(decodeURIComponent(raw), 'id'); }
  catch (error) { if (error instanceof ConversationError) throw error; return invalid('invalid encoded ID'); }
}
function query(params: URLSearchParams, allowed: readonly string[], maximum: number) {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid('invalid or repeated query parameter');
  const options: { cursor?: string; limit?: number } = {};
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(n) || n > maximum) invalid(`limit must be between 1 and ${maximum}`);
    options.limit = n;
  }
  const cursor = params.get('cursor');
  if (cursor !== null) {
    if (!cursor || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid('invalid cursor');
    options.cursor = cursor;
  }
  return options;
}
function fields(body: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) invalid(`body.${key}: unknown field`);
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** One instance per gateway: HTTP and WebSocket share the same stream epoch. */
export function createConversationMessagingHandler(store: WorkspaceStore) {
  const stream = createConversationStream(store);
  let disposed = false;
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const conversation = url.pathname.match(/^\/api\/conversations\/([^/]+)\/(inbox|outbox|changes|snapshot)$/);
    const detail = url.pathname.match(/^\/api\/peer-messages\/([^/]+)$/);
    // cancel 给排队中的；dismiss 给状态不明的；remove 给已经结束的（从待发区拿走）。
    // 三个出口合起来覆盖全部状态——少一个，界面上就会有一格永远清不掉。
    const cancel = url.pathname.match(/^\/api\/peer-deliveries\/([^/]+)\/(cancel|dismiss|remove)$/);
    if (!conversation && !detail && !cancel) return false;
    try {
      if (disposed) throw new ConversationError(503, 'storage_unavailable', 'conversation messaging is shutting down');
      const route = conversation?.[2];
      const id = pathIdentifier((conversation ?? detail ?? cancel)![1]);
      const allowed = cancel ? ['POST'] : route === 'inbox' ? ['GET', 'POST'] : ['GET'];
      if (!allowed.includes(req.method ?? '')) {
        res.setHeader('allow', allowed.join(', '));
        throw new ConversationError(405, 'method_not_allowed', 'method not allowed');
      }
      if (req.method === 'POST') {
        query(url.searchParams, [], 100);
        const body = await readJson(req, cancel ? 1024 : 128 * 1024);
        if (cancel) {
          fields(body, []);
          const changed = cancel[2] === 'dismiss' ? store.peerMessages.dismiss(id)
            : cancel[2] === 'remove' ? store.peerMessages.remove(id) : store.peerMessages.cancel(id);
          /*
            **返回整条（消息 + 投递），不是光一个投递。**

            store 那三个函数返回的都是 `PeerDelivery`，而调用方按 `{message, delivery}` 用：
            前端 `merge()` 拿 `detail.message.id` 去替换列表里那一条。返回里没有 `message`
            时它读 undefined.id，异常抛在 render 里，被 ErrorBoundary 接住——**整个右侧面板
            一起变成降级文案**，而不是只坏掉那一个按钮。

            实测撞到（2026-09-23）：点「移除」当场白屏报
            `Cannot read properties of undefined (reading 'id')`。cancel 和 dismiss
            一直是同样的形状，只是很少有人连着点，所以一直没暴露。
          */
          json(res, 200, store.peerMessages.get(changed.messageId));
        } else {
          fields(body, ['requestId', 'text', 'inReplyTo']);
          const requestId = identifier(body.requestId, 'requestId');
          if (typeof body.text !== 'string') invalid('text: string required');
          let inReplyTo: string | null | undefined;
          if (Object.hasOwn(body, 'inReplyTo')) inReplyTo = body.inReplyTo === null ? null : identifier(body.inReplyTo, 'inReplyTo');
          // User identity is supplied by this trusted local endpoint, never by the body or headers.
          const result = store.peerMessages.send({ kind: 'user' }, { recipientId: id, requestId, text: body.text as string, ...(inReplyTo === undefined ? {} : { inReplyTo }) });
          // This acknowledges a durable logical request. Read delivery.state for actual receipt.
          json(res, 202, result);
        }
      } else if (route === 'inbox' || route === 'outbox') {
        json(res, 200, store.peerMessages[route](id, query(url.searchParams, ['cursor', 'limit'], 100)));
      } else if (route === 'changes') {
        json(res, 200, stream.read(id, query(url.searchParams, ['cursor', 'limit'], 200)));
      } else {
        query(url.searchParams, [], 100);
        json(res, 200, detail ? store.peerMessages.get(id) : stream.snapshot(id));
      }
    } catch (error) {
      if (error instanceof ConversationError || error instanceof PeerMessageError) {
        json(res, error.status, { error: { code: error.code, message: error.message } });
      } else if (error instanceof HttpInputError) {
        json(res, error.status, { error: { code: error.status === 413 ? 'too_large' : 'invalid_request', message: error.message } });
      } else {
        json(res, 503, { error: { code: 'storage_unavailable', message: 'conversation storage temporarily unavailable; retry later' } });
      }
    }
    return true;
  }
  return { handle, attach: stream.attach, dispose() { disposed = true; stream.dispose(); } };
}
