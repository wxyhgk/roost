import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TerminalService } from '@roost/terminal-runtime';
import { ConversationError, type WorkspaceStore } from '@roost/workspace-store';

/** A momentary location, never authorization to write to or restart a terminal. */
export async function handleConversationRuntime(req: IncomingMessage, res: ServerResponse, url: URL,
  store: WorkspaceStore, runtime: TerminalService): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/conversations\/([^/]+)\/runtime$/);
  const terminalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/conversation$/);
  if (!match && !terminalMatch) return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    let id: string;
    try { id = decodeURIComponent((match ?? terminalMatch)![1]); } catch { throw new ConversationError(400, 'invalid_request', 'invalid runtime lookup ID'); }
    if (!id || id.length > 4096 || /[\u0000-\u001f\u007f]/.test(id) || url.searchParams.size)
      throw new ConversationError(400, 'invalid_request', 'invalid conversation runtime query');
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      throw new ConversationError(405, 'method_not_allowed', 'method not allowed');
    }
    if (terminalMatch) {
      if (!store.getSessionRecord(id)) throw new ConversationError(404, 'not_found', 'terminal not found');
    } else {
      const conversation = store.conversations.get(id);
      if (conversation.trashedAt !== null) throw new ConversationError(409, 'conversation_trashed', 'restore the conversation before locating its terminal');
    }
    const resolve = terminalMatch ? runtime.resolveTerminalConversation : runtime.resolveConversationRuntime;
    if (!resolve || runtime.isConnected?.() === false)
      throw new ConversationError(503, 'runtime_unavailable', 'terminal daemon unavailable or does not support conversation lookup');
    const result = await resolve.call(runtime, id);
    if (runtime.isConnected?.() === false) throw new ConversationError(503, 'runtime_unavailable', 'terminal daemon disconnected');
    // Recheck after IPC: a terminal may have switched CLI or binding while the
    // response was in flight. The daemon alone establishes current ownership.
    if (terminalMatch && result.webSessionId !== id)
      throw new ConversationError(409, 'run_unavailable', 'terminal identity changed during lookup');
    const conversationId = terminalMatch ? result.conversationId : id;
    const current = store.conversations.get(conversationId);
    if (current.trashedAt !== null) throw new ConversationError(409, 'conversation_trashed', 'conversation is in trash');
    const run = store.conversationRuns.active(conversationId);
    const binding = store.aiSessions.list().find(record => record.binding.webSessionId === result.webSessionId)?.binding;
    const terminal = store.getSessionRecord(result.webSessionId);
    const live = runtime.getSession(result.webSessionId);
    if (result.runtimeVerified !== true || result.conversationId !== conversationId || !run || run.id !== result.runId
      || run.sourceId !== current.source.id || run.webSessionId !== result.webSessionId
      || run.cliId !== current.source.cliId || run.nativeSessionId !== current.source.nativeSessionId
      || run.terminalInstanceId !== result.terminalInstanceId || run.generation !== result.generation
      || run.cliId !== result.cliId || run.nativeSessionId !== result.nativeSessionId
      || !terminal || terminal.closed || live?.instanceId !== result.terminalInstanceId || live.cli !== result.cliId
      || !Number.isSafeInteger(live.pid) || live.pid <= 0
      || binding?.generation !== result.generation || binding.terminalInstanceId !== result.terminalInstanceId
      || binding.cliId !== result.cliId || binding.nativeSessionId !== result.nativeSessionId)
      throw new ConversationError(409, 'run_unavailable', 'conversation no longer has this active terminal');
    json(200, result);
  } catch (error) {
    if (error instanceof ConversationError) json(error.status, { error: { code: error.code, message: error.message } });
    else {
      const code = (error as { code?: string })?.code;
      const known = { run_unavailable: 409, conversation_trashed: 409, not_found: 404, invalid_request: 400 } as const;
      const status = code && Object.hasOwn(known, code) ? known[code as keyof typeof known] : 503;
      json(status, { error: { code: status === 503 ? 'runtime_unavailable' : code,
        message: status === 503 ? 'terminal runtime temporarily unavailable' : 'conversation has no available terminal location' } });
    }
  }
  return true;
}
