import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceStore } from '@roost/workspace-store';
import type { TerminalService } from '@roost/terminal-runtime';
import { MAX_DIRECT_INPUT_BYTES } from '@roost/terminal-protocol';
import { readJson, HttpInputError, sendError, type ApiErrorCode } from './http';

/**
 * `POST /api/ai-sessions/:id/type {text}` —— 往这个终端里的 CLI 直接打一句话。
 *
 * 只认终端，不认「这是哪个对话」：写给哪个终端就是哪个终端。为什么不再核对身份链，见
 * terminal-daemon/src/direct-input.ts 顶上。结果原样转给前端，它只描述这一句。
 */
export function createDirectInputHandler(store: WorkspaceStore, runtime: TerminalService) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const match = url.pathname.match(/^\/api\/ai-sessions\/([^/]+)\/type$/);
    if (!match) return false;
    try {
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); sendError(res, 405, 'method_not_allowed', 'POST required'); return true; }
      const id = decodeURIComponent(match[1]);
      if (!store.getSessionRecord(id)) { sendError(res, 404, 'not_found', 'session not found'); return true; }
      // 正文上限之外留一点给 JSON 包装和转义。
      const body = await readJson(req, MAX_DIRECT_INPUT_BYTES * 2 + 1024);
      if (Object.keys(body).some(key => key !== 'text')) throw new HttpInputError(400, 'unexpected field');
      if (!runtime.typeText) { sendError(res, 409, 'control_unavailable', 'daemon does not support typing'); return true; }
      const result = await runtime.typeText(id, body.text as string);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof HttpInputError) { sendError(res, error.status, error.status === 413 ? 'too_large' : 'invalid_request', error.message); return true; }
      const e = error as { status?: number; code?: string };
      const allowed: ApiErrorCode[] = ['invalid_request', 'too_large', 'not_found'];
      if (e.status && e.code && (allowed as string[]).includes(e.code)) sendError(res, e.status, e.code as ApiErrorCode, e.code);
      // 新 backend 配旧 daemon：daemon 不认识这个操作。它不是坏了，是还没重启到新版本。
      else if (error instanceof Error && error.message === 'unknown terminal operation') sendError(res, 409, 'control_unavailable', 'terminal service needs a restart to support typing');
      else if (error instanceof URIError) sendError(res, 400, 'invalid_request', 'invalid path');
      else sendError(res, 503, 'control_unavailable', 'terminal daemon unavailable');
    }
    return true;
  };
}
