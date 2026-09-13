import { createSubscriptionsHandler } from './subscriptions/handler';
import { createServerMonitorHandler } from './server-monitor';
import { createAiCommandHandler, commandControl } from './ai-commands';
import { createClaudeObserver } from "./claude-observer";
import { AiIdentityError, readIdentityCandidate } from "./ai-identity";
import { createFileUploadHandler } from "./file-upload";
import { createAiTranscriptSource } from "./ai-transcript-source";
import { readTranscriptDetail, TranscriptError, type TranscriptItem } from "@roost/ai-transcript";
import { createDiagnostics } from "./diagnostics";
import { createAiAgentSource } from "./ai-agent-source";
import { attachAiSessionStream } from "./ai-session-stream";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, MAX_WS_BYTES, PROTOCOL_VERSION, type ServerMessage } from "@roost/terminal-protocol";
import type { TerminalService, TerminalEvent } from "@roost/terminal-runtime";
import { ConversationError, ProjectNotFoundError, normalizeSessionNote, type WorkspaceStore } from "@roost/workspace-store";
import { listCliAdapters, planImageInsertion, getCliAdapter, type CliId } from "@roost/cli-adapters";
import { AttachmentError, type AttachmentStore } from "./attachments";
import { createAccessPolicy, type AccessOptions } from "./access";
import { RESYNC_INTERVAL_MS, RESYNC_RESUME_BYTES, sendTerminalMessage, selectTerminalReplay } from "./terminalTransport";
import { handleCliConfigs, type CliIconStore } from "./cli-configs";
import { handleBookmarks } from "./bookmarks";
import { createSessionStatus } from "./session-status";
import { handleLibrary } from "./library";
import { handleAiHistory } from "./ai-history";
import { handleConversations } from "./conversations";
import { handleConversationRuntime } from "./conversation-runtime";
import { createConversationMessagingHandler } from "./peer-messages";
import { createAuthentication, type AuthOptions } from "./auth";
import { createFileAccess, FileAccessError } from "./file-access";
import { HttpInputError, readJson, sendError } from "./http";
import { listDir, walkFiles, readPreview, statRawFile, writeFileAtomic, createPath, renamePath, deletePath, FileWriteError, MAX_FILE_REQUEST_BYTES, MAX_RAW_BYTES } from "./fs";
import { createFileWatcher } from "./watcher";
import { createIsolatedFileWatcher } from './watcher-process';
import { createAiSessionBridge, AiSessionBridgeError, type AiSessionBridge } from "@roost/ai-session-bridge";
import { createSessionResume, type ResumePlan } from "./session-resume.ts";
/* 前端拿到 GET .../resume 之后按钮就不该出现了；走到这里说明中间变了，文案给的是那个变化。 */
const RESUME_UNAVAILABLE = {
  no_conversation: "this terminal has no AI conversation to resume",
  unsupported_cli: "this CLI cannot be resumed by session id",
  unusable_session_id: "the recorded session id is not usable",
  identity_syncing: "the latest AI session identity is still syncing; retry shortly",
  identity_unconfirmed: "the latest AI session identity could not be confirmed",
  source_unavailable: "the terminal identity journal is unavailable",
} as const;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}


export function createBackendServer({ store, runtime, workspaceRoot, access, auth, attachments, cliIcons, sessionBridge, monitorDataDir }: {
  monitorDataDir?: string;
  store: WorkspaceStore;
  runtime: TerminalService;
  workspaceRoot: string;
  access?: AccessOptions;
  auth?: AuthOptions | false;
  attachments?: AttachmentStore;
  cliIcons?: CliIconStore;
  sessionBridge?: AiSessionBridge;
}) {
  const serverMonitor = createServerMonitorHandler(monitorDataDir);
  const subscriptions = createSubscriptionsHandler(monitorDataDir);
  const checkAccess = createAccessPolicy(access);
  const authentication = createAuthentication(auth);
  const allowedFileRoot = createFileAccess(store, runtime);
  const handleFileUpload = createFileUploadHandler();
  const handleAiCommands = createAiCommandHandler(store,runtime);
  const conversationMessaging = createConversationMessagingHandler(store);
  const sessionStatus = createSessionStatus(store, runtime);
  const fileWatcher = process.platform === 'darwin' ? createIsolatedFileWatcher() : createFileWatcher();
  const aiBridge = sessionBridge ?? createAiSessionBridge({ storage: store.aiSessions });
  const {
    createProject, deleteProjectRecord, deleteSessionRecord: deleteStoredSession, getProjectRecord, getSessionRecord, loadWorkspace,
    setExpandedProjectIds, setPinnedSessionIds, setSelectedId, setProjectName, setSessionClosed, setSessionCwd,
    setSessionProject, setSessionTitle, upsertSession,
  } = store;
  const aiConnections = new Map<string, Set<WebSocket>>();
  // 自动换绑同样要断开旧连接：rebind 清空了订阅者，留着那条流只会静默到天荒地老。
  // 客户端重连时以 afterSeq=0 重取，拿到的是新一代的完整快照，不会与旧的拼接。
  const aiAgentSource = createAiAgentSource(store, runtime, aiBridge, id => {
    for (const ws of aiConnections.get(id) ?? []) ws.close(1008, "binding generation changed");
    aiConnections.delete(id);
  });
  const aiTranscriptSource = createAiTranscriptSource(aiBridge);
  const claudeObserver = createClaudeObserver({ bridge: aiBridge, resolveInstance: id => { try { return getSessionRecord(id) ? runtime.getSession(id)?.instanceId : undefined; } catch { return undefined; } }, onBound: id => { void aiTranscriptSource.catchUp(id); } });
  const aiSyncStatus = (id: string) => ({ ...aiAgentSource.status(id), transcript: aiTranscriptSource.status(id) });
  const diagnostics = createDiagnostics(store, runtime, aiBridge, aiSyncStatus);
  const resumePlan = createSessionResume(store, aiBridge);
  const verifiedResumePlan = async (id: string): Promise<ResumePlan> => {
    const initial = resumePlan(id);
    if (!initial.available) return initial;
    const reason = await aiAgentSource.prepareResume(id);
    return reason ? { available: false, reason } : resumePlan(id);
  };
  const deleteSessionRecord = (id: string) => {
    deleteStoredSession(id);
    void claudeObserver.revoke(id).catch(() => { console.warn("Claude observer directory cleanup failed"); });
    aiBridge.unbind(id);
    for (const ws of aiConnections.get(id) ?? []) ws.close(1008, "session deleted");
    aiConnections.delete(id);
  };
  const { resolveCwd, writeSession, resizeSession, killSession, setSnapshot, subscribe } = runtime;
  const connections = new Map<string, Set<WebSocket>>();
  const viewerLabels = new WeakMap<WebSocket, string>();
  const dropClients = (id: string) => {
    for (const ws of connections.get(id) ?? []) ws.close();
  };
  const wireCli = (cli: CliId | null) => cli !== "opencode" && getCliAdapter(cli) ? cli : null;
  const send = (ws: WebSocket, message: ServerMessage | { type: "cli"; cli: CliId | null }) =>
    sendTerminalMessage(ws, message.type === "cli" ? { ...message, cliId: message.cli, cli: wireCli(message.cli) } : message);
  function snapshot() {
    const ws = loadWorkspace();
    return {
      ...ws,
      sessions: ws.sessions.map((session) => {
        const live = runtime.getSession(session.id);
        return {
          ...session,
          cwd: live?.cwd ?? session.cwd,
          cliId: live?.cli ?? null,
          cli: wireCli(live?.cli ?? null),
        };
      }),
    };
  }

  function validateProjectId(body: Record<string, unknown>) {
    if ("projectId" in body && body.projectId !== null && typeof body.projectId !== "string") {
      throw new HttpInputError(400, "projectId must be a string or null");
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const decision = checkAccess(req);
    for (const [key, value] of Object.entries(decision.headers)) res.setHeader(key, value);
    if (!decision.allowed) { text(res, 403, "forbidden origin or host"); return; }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const { pathname, searchParams } = url;

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (await authentication.handle(req, res, url)) return;
    if (!authentication.require(req, res)) return;
    if (await serverMonitor.handle(req, res, url)) return;
    if (await subscriptions.handle(req, res, url)) return;
    if (['/api/fs', '/api/fs/tree', '/api/file', '/api/file/raw', '/api/fs/file'].includes(pathname) && searchParams.has('root')) {
      if (searchParams.getAll('root').length !== 1) throw new HttpInputError(400, 'duplicate root');
      searchParams.set('root', await allowedFileRoot(searchParams.get('root')!));
    }

    if (req.method === "GET" && pathname === "/api/diagnostics") {
      json(res, 200, diagnostics()); return;
    }
    if (req.method === "GET" && pathname === "/api/session-status") {
      json(res, 200, sessionStatus.snapshot()); return;
    }
    if (await handleAiCommands(req,res,url)) return;
    if (await conversationMessaging.handle(req, res, url)) return;
    if (await handleConversations(req, res, url, store.conversations)) return;
    if (await handleConversationRuntime(req, res, url, store, runtime)) return;
    if (await claudeObserver.handle(req, res, url)) return;
    if (handleAiHistory(req, res, url, store.aiSessions.history)) return;
    if (req.method === "GET" && pathname === "/api/ai-sessions") { json(res, 200, { sessions: aiBridge.list() }); return; }
    const transcriptDetail = pathname.match(/^\/api\/ai-sessions\/([^/]+)\/transcript\/([^/]+)$/);
    if (transcriptDetail && req.method === "GET") {
      try {
        const id = decodeURIComponent(transcriptDetail[1]), eventId = decodeURIComponent(transcriptDetail[2]);
        const entry = aiBridge.read(id, 0, searchParams.get("generation") ?? undefined).events.find(item => item.event.eventId === eventId);
        const data = entry?.event.data as TranscriptItem["data"] | undefined;
        if (data?.source !== "transcript" || !data.detail) { sendError(res,404,"not_found","transcript entry not retained"); return; }
        const detail = await readTranscriptDetail(data.detail);
        if (aiBridge.get(id)?.generation !== entry!.generation) throw new AiSessionBridgeError(409,"binding generation changed");
        json(res,200,{event:detail});
      } catch (error) {
        if (error instanceof AiSessionBridgeError) sendError(res,error.status,error.status===404?"not_found":"conflict",error.message);
        else if (error instanceof URIError) sendError(res,400,"invalid_request","invalid transcript identifier");
        else sendError(res,409,"conflict",error instanceof TranscriptError ? error.code : "transcript detail unavailable");
      }
      return;
    }
    const rebindRoute = pathname.match(/^\/api\/ai-sessions\/([^/]+)\/rebind$/);
    if (rebindRoute && req.method === "POST") {
      try {
        const id = decodeURIComponent(rebindRoute[1]), body = await readJson(req);
        if (!getSessionRecord(id)) throw new AiSessionBridgeError(404, "workspace session not found");
        if (typeof body.expectedGeneration !== "string" || !Number.isSafeInteger(body.expectedRevision) ||
          typeof body.terminalInstanceId !== "string" || typeof body.cliId !== "string" || typeof body.nativeSessionId !== "string")
          throw new AiSessionBridgeError(400, "binding identity and expected version required");
        const candidate = await readIdentityCandidate(runtime, id, {
          terminalInstanceId: body.terminalInstanceId, cliId: body.cliId,
          requireExplicitCli: aiBridge.get(id)?.cliId !== body.cliId || aiBridge.source(id).requiresCli,
        });
        if (candidate.nativeSessionId !== body.nativeSessionId)
          throw new AiIdentityError("identity_unconfirmed", "native identity not confirmed");
        const previousGeneration = aiBridge.get(id)?.generation;
        const binding = aiBridge.rebind({ webSessionId: id, terminalInstanceId: body.terminalInstanceId, cliId: body.cliId,
          nativeSessionId: candidate.nativeSessionId, transcriptPath: candidate.transcriptPath },
          body.expectedGeneration, body.expectedRevision as number, candidate.boundarySeq - 1);
        if (binding.generation !== previousGeneration) {
          for (const ws of aiConnections.get(id) ?? []) ws.close(1008, "binding generation changed");
          aiConnections.delete(id);
        }
        json(res, 200, { binding });
        void aiAgentSource.catchUp(id);
      } catch (error) {
        if (error instanceof URIError) sendError(res, 400, "invalid_request", "invalid session ID");
        else if (error instanceof AiIdentityError) sendError(res, error.status, error.code, error.message);
        else if (error instanceof AiSessionBridgeError) sendError(res, error.status, error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid_request", error.message);
        else if (error instanceof HttpInputError) sendError(res,error.status,error.status===413?"too_large":"invalid_request",error.message);
        else sendError(res,503,"storage_unavailable","rebind temporarily unavailable");
      }
      return;
    }
    const aiSession = pathname.match(/^\/api\/ai-sessions\/([^/]+)$/);
    if (aiSession) {
      try {
        const id = decodeURIComponent(aiSession[1]);
        if (req.method === "GET") {
          const binding = aiBridge.get(id);
          if (!binding) throw new AiSessionBridgeError(404, "session binding not found");
          const after = searchParams.get("afterSeq");
          const cursor = after === null ? 0 : /^\d+$/.test(after) ? Number(after) : NaN;
          json(res, 200, { binding, ...aiBridge.read(id, cursor, searchParams.get("generation") ?? undefined), sync: aiSyncStatus(id), control: await commandControl(runtime,id) });
        } else if (req.method === "POST") {
          const body = await readJson(req);
          if (!getSessionRecord(id)) throw new AiSessionBridgeError(404, "workspace session not found");
          if (body.webSessionId !== undefined && body.webSessionId !== id) throw new AiSessionBridgeError(400, "session ID mismatch");
          for (const key of ["terminalInstanceId", "cliId", "nativeSessionId"]) {
            if (typeof body[key] !== "string" || !(body[key] as string).trim()) throw new AiSessionBridgeError(400, key + " required");
          }
          const live = runtime.getSession(id);
          if (!live || live.instanceId !== body.terminalInstanceId || live.cli !== body.cliId)
            throw new AiSessionBridgeError(409, "terminal instance or CLI mismatch");
          const binding = aiBridge.bind({ webSessionId: id, terminalInstanceId: body.terminalInstanceId as string,
            cliId: body.cliId as string, nativeSessionId: body.nativeSessionId as string,
            transcriptPath: body.transcriptPath as string | null | undefined });
          json(res, 200, { binding });
        } else sendError(res, 405, "method_not_allowed", "method not allowed");
      } catch (error) {
        if (error instanceof URIError) sendError(res, 400, "invalid_request", "invalid session ID");
        else if (error instanceof AiSessionBridgeError || error instanceof HttpInputError)
          sendError(res, error.status, error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : error.status === 413 ? "too_large" : "invalid_request", error.message);
        else throw error;
      }
      return;
    }

    if (await handleCliConfigs(req, res, url, store, cliIcons)) return;
    if (await handleBookmarks(req, res, url, store)) return;
    if (await handleLibrary(req, res, url, store)) return;

    if (req.method === "GET" && pathname === "/api/cli-adapters") {
      json(res, 200, { adapters: listCliAdapters() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        workspace: workspaceRoot,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/workspace") {
      json(res, 200, snapshot());
      return;
    }

    if (req.method === "PATCH" && pathname === "/api/workspace") {
      const body = await readJson(req);
      try {
        const allowed = ['selectedId', 'expandedProjectIds', 'pinnedSessionIds', 'selectedConversationId', 'followTerminalConversation'];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw new ConversationError(400, 'invalid_request', 'unknown workspace preference');
        if ('selectedConversationId' in body || 'followTerminalConversation' in body) {
          store.patchConversationSelection({
            ...('selectedConversationId' in body ? { selectedConversationId: body.selectedConversationId as string | null } : {}),
            ...('followTerminalConversation' in body ? { followTerminalConversation: body.followTerminalConversation as boolean } : {}),
          });
        }
      } catch (error) {
        if (!(error instanceof ConversationError)) throw error;
        json(res, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      if ("selectedId" in body) {
        setSelectedId(typeof body.selectedId === "string" ? body.selectedId : null);
      }
      if (Array.isArray(body.expandedProjectIds)) {
        setExpandedProjectIds(body.expandedProjectIds.filter((id) => typeof id === "string"));
      }
      if (Array.isArray(body.pinnedSessionIds)) {
        setPinnedSessionIds(body.pinnedSessionIds.filter((id) => typeof id === "string"));
      }
      json(res, 200, snapshot());
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects") {
      const body = await readJson(req);
      const project = createProject({
        id: typeof body.id === "string" ? body.id : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
        color: typeof body.color === "string" ? body.color : undefined,
      });
      const expanded = loadWorkspace().expandedProjectIds;
      if (!expanded.includes(project.id)) {
        setExpandedProjectIds([...expanded, project.id]);
      }
      json(res, 201, project);
      return;
    }

    if (req.method === "POST" && pathname === "/api/sessions") {
      const body = await readJson(req);
      validateProjectId(body);
      const cwd = resolveCwd(typeof body.cwd === "string" ? body.cwd : undefined);
      const record = upsertSession({
        id: typeof body.id === "string" ? body.id : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
        cwd,
        projectId:
          "projectId" in body
            ? typeof body.projectId === "string"
              ? body.projectId
              : null
            : undefined,
        closed: "closed" in body ? body.closed === true : undefined,
      });
      sessionStatus.refresh();
      if (!record.closed) await runtime.ensureSession(record.id, record.cwd);
      const liveCwd = runtime.getSession(record.id)?.cwd;
      if (liveCwd) {
        setSessionCwd(record.id, liveCwd);
        record.cwd = liveCwd;
      }
      if (!record.closed) setSelectedId(record.id);
      aiAgentSource.refresh();
      json(res, 201, record);
      return;
    }

    const resumeQuery = pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);
    if (resumeQuery && req.method === "GET") {
      const id = decodeURIComponent(resumeQuery[1]);
      if (!getSessionRecord(id)) { text(res, 404, "session not found"); return; }
      json(res, 200, await verifiedResumePlan(id));
      return;
    }

    const action = pathname.match(/^\/api\/sessions\/([^/]+)\/(close|reopen|kill)$/);
    if (action && req.method === "POST") {
      const id = decodeURIComponent(action[1]);
      const record = getSessionRecord(id);
      if (!record) {
        text(res, 404, "session not found");
        return;
      }
      if (action[2] === "close") {
        setSessionClosed(id, true);
        dropClients(id);
        await runtime.flush(id);
        const workspace = loadWorkspace();
        if (workspace.selectedId === id) {
          setSelectedId(workspace.sessions.find((s) => !s.closed)?.id ?? null);
        }
        json(res, 200, snapshot());
        return;
      }
      if (action[2] === "kill") {
        await killSession(id);
        deleteSessionRecord(id);
        const workspace = loadWorkspace();
        if (workspace.selectedId === id) {
          setSelectedId(workspace.sessions.find((s) => !s.closed)?.id ?? null);
        }
        json(res, 200, snapshot());
        return;
      }
      /*
        重开一个死掉的终端时，可以顺手把它原来那条 AI 对话接着跑起来。

        只有这条路能这么干：终端已经没有 PTY，命令是**这个进程的 argv**，不是往某个
        已经跑着的东西里敲字。前端要先拿到 GET .../resume 说「可以」才会带这个标志，
        所以这里再算一次不是多余——那次响应和这次请求之间，绑定可能已经变了。
      */
      const wantsResume = (await readJson(req).catch(() => ({})) as { resume?: unknown }).resume === true;
      if (wantsResume && runtime.getSession(id)) {
        sendError(res, 409, "conflict", "the terminal is already running; resume only applies to one that has exited");
        return;
      }
      const plan = wantsResume ? await verifiedResumePlan(id) : null;
      if (!getSessionRecord(id)) { text(res, 404, "session not found"); return; }
      if (plan && !plan.available) {
        sendError(res, 409, plan.reason, RESUME_UNAVAILABLE[plan.reason]);
        return;
      }
      // ensureSession 对着活的会话是个 no-op。恢复要是撞上这种情况，200 回去等于「点了，
      // 什么也没发生」——那是最难查的一种。终端已经回来了就直说，别假装恢复过。
      if (plan && runtime.getSession(id)) {
        sendError(res, 409, "conflict", "the terminal is already running; resume only applies to one that has exited");
        return;
      }
      setSessionClosed(id, false);
      sessionStatus.refresh();
      await runtime.ensureSession(id, record.cwd, plan?.command);
      const cwd = runtime.getSession(id)?.cwd;
      if (cwd) setSessionCwd(id, cwd);
      setSelectedId(id);
      json(res, 200, snapshot());
      return;
    }

    const sessionOne = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionOne) {
      const id = decodeURIComponent(sessionOne[1]);
      const record = getSessionRecord(id);
      if (!record) {
        text(res, 404, "session not found");
        return;
      }
      if (req.method === "GET") {
        const live = runtime.getSession(id);
        json(res, 200, {
          ...record,
          cwd: live?.cwd ?? record.cwd,
          cliId: live?.cli ?? null,
          cli: wireCli(live?.cli ?? null),
        });
        return;
      }
      if (req.method === "PATCH") {
        const body = await readJson(req);
        validateProjectId(body);
        if (!getSessionRecord(id)) { text(res, 404, "session not found"); return; }
        let note: string | null = null;
        if ("note" in body) {
          try { note = normalizeSessionNote(body.note); }
          catch (error) {
            sendError(res, 400, "invalid_request", (error as Error).message);
            return;
          }
        }
        if ("beforeId" in body) {
          if (body.beforeId !== null && typeof body.beforeId !== "string") {
            throw new HttpInputError(400, "beforeId must be a string or null");
          }
          if (typeof body.beforeId === "string" && !getSessionRecord(body.beforeId)) {
            throw new HttpInputError(400, "beforeId session not found");
          }
        }
        if ("projectId" in body) {
          const projectId = typeof body.projectId === "string" ? body.projectId : null;
          setSessionProject(id, projectId);
          if (projectId) {
            const expanded = loadWorkspace().expandedProjectIds;
            if (!expanded.includes(projectId)) {
              setExpandedProjectIds([...expanded, projectId]);
            }
          }
        }
        if (typeof body.title === "string") {
          const title = body.title.trim();
          if (title) setSessionTitle(id, title);
        }
        if ("beforeId" in body) store.reorderSession(id, body.beforeId as string | null);
        if ("note" in body) store.setSessionNote(id, note);
        json(res, 200, getSessionRecord(id));
        return;
      }
    }

    const projectOne = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectOne && req.method === "DELETE") {
      const id = decodeURIComponent(projectOne[1]);
      if (!deleteProjectRecord(id)) {
        text(res, 404, "project not found");
        return;
      }
      json(res, 200, snapshot());
      return;
    }
    if (projectOne && req.method === "PATCH") {
      const id = decodeURIComponent(projectOne[1]);
      if (!getProjectRecord(id)) {
        text(res, 404, "project not found");
        return;
      }
      const body = await readJson(req);
      if ("beforeId" in body) {
        if (body.beforeId !== null && typeof body.beforeId !== "string") {
          throw new HttpInputError(400, "beforeId must be a string or null");
        }
        if (typeof body.beforeId === "string" && !getProjectRecord(body.beforeId)) {
          throw new HttpInputError(400, "beforeId project not found");
        }
      }
      if (typeof body.name === "string") {
        const name = body.name.trim();
        if (name) setProjectName(id, name);
      }
      if ("beforeId" in body) store.reorderProject(id, body.beforeId as string | null);
      json(res, 200, getProjectRecord(id));
      return;
    }

    if (await handleFileUpload(req, res, url)) return;
    if (pathname === "/api/fs" && (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE")) {
      const body = await readJson(req);
      if (typeof body.root !== "string" || !body.root || typeof body.path !== "string" || !body.path) {
        throw new HttpInputError(400, "root and path required");
      }
      body.root = await allowedFileRoot(body.root as string);
      if (req.method === "POST" && body.kind !== "file" && body.kind !== "dir") {
        throw new HttpInputError(400, "kind must be file or dir");
      }
      if (req.method === "PATCH" && (typeof body.newPath !== "string" || !body.newPath)) {
        throw new HttpInputError(400, "newPath required");
      }
      try {
        if (req.method === "POST") {
          json(res, 201, await createPath(body.root as string, body.path, body.kind as "file" | "dir"));
        } else if (req.method === "PATCH") {
          json(res, 200, await renamePath(body.root as string, body.path, body.newPath as string));
        } else {
          json(res, 200, await deletePath(body.root as string, body.path));
        }
      } catch (error) {
        if (error instanceof FileWriteError) {
          sendError(res, error.status, error.status === 409 ? "conflict" : error.status === 413 ? "too_large" : error.status === 415 ? "binary_file" : "not_file", error.message);
        } else {
          const code = (error as NodeJS.ErrnoException).code;
          const message = error instanceof Error ? error.message : "file error";
          if (message === "path escapes workspace") sendError(res, 403, "path_escape", message);
          else if (code === "ENOENT") sendError(res, 404, "not_found", message);
          else if (code === "EACCES" || code === "EPERM") sendError(res, 403, "permission_denied", message);
          else if (code === "ENOTDIR" || code === "EISDIR" || code === "ENOTEMPTY") sendError(res, 400, "not_file", message);
          else sendError(res, 500, "internal_error", "file operation failed");
        }
      }
      return;
    }

    if (req.method === "PUT" && pathname === "/api/file") {
      try {
        const body = await readJson(req, MAX_FILE_REQUEST_BYTES);
        if (typeof body.root !== "string" || !body.root || typeof body.path !== "string" || !body.path
          || typeof body.content !== "string" || typeof body.mtime !== "number" || !Number.isFinite(body.mtime)) {
          throw new HttpInputError(400, "root, path, content and numeric mtime required");
        }
        json(res, 200, await writeFileAtomic(await allowedFileRoot(body.root), body.path, body.content, body.mtime));
      } catch (error) {
        if (error instanceof FileAccessError) { sendError(res, 403, 'root_not_allowed', error.message); return; }
        if (error instanceof HttpInputError) {
          sendError(res, error.status, error.status === 413 ? "too_large" : "invalid_request", error.message);
        } else if (error instanceof FileWriteError) {
          const code = error.status === 409 ? "file_conflict" : error.status === 413 ? "too_large"
            : error.status === 415 ? "binary_file" : "not_file";
          // Keep the existing flat conflict preview and message for older clients.
          sendError(res, error.status, code, error.message, { message: error.message, ...error.current });
        } else {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (error instanceof Error && error.message === "path escapes workspace")
            sendError(res, 403, "path_escape", "path escapes workspace");
          else if (code === "ENOENT") sendError(res, 404, "not_found", "file not found");
          else if (code === "EACCES" || code === "EPERM") sendError(res, 403, "permission_denied", "file access denied");
          else if (code === "ENOTDIR" || code === "EISDIR") sendError(res, 400, "not_file", "not a file");
          else {
            console.error("file save failed", error);
            sendError(res, 500, "internal_error", "file save failed");
          }
        }
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/attachments") {
      if (!attachments) { json(res, 503, {message:"attachment storage unavailable"}); return; }
      const usage = await attachments.usage();
      const records = new Map(loadWorkspace().sessions.map(record => [attachments.sessionKey(record.id),record]));
      json(res, 200, {...usage, sessions:usage.sessions.map(group => {
        const record = records.get(group.sessionKey);
        return {...group,sessionId:record?.id??null,title:record?.title??null,running:record?Boolean(runtime.getSession(record.id)):false};
      })});
      return;
    }
    const managedAttachments = pathname.match(/^\/api\/attachments\/([^/]+)(?:\/([^/]+))?$/);
    if (managedAttachments && (req.method === "GET" || req.method === "DELETE")) {
      if (!attachments) { json(res,503,{message:"attachment storage unavailable"}); return; }
      const key=managedAttachments[1],name=managedAttachments[2];
      try {
        if(req.method === "GET" && !name) json(res,200,{files:await attachments.list(key)});
        else if(req.method === "DELETE" && name) {
          const canRemove=()=>!loadWorkspace().sessions.some(record=>attachments.sessionKey(record.id)===key&&runtime.getSession(record.id));
          json(res,200,await attachments.remove(key,name,canRemove));
        } else json(res,400,{message:"list a session key or delete a specific attachment filename"});
      } catch(error) {
        if(error instanceof AttachmentError)json(res,error.status,{message:error.message});
        else if((error as NodeJS.ErrnoException).code==='ENOENT')json(res,404,{message:"attachment not found"});
        else throw error;
      }
      return;
    }

    const attachmentRoute = pathname.match(/^\/api\/sessions\/([^/]+)\/attachments$/);
    if (req.method === "POST" && attachmentRoute) {
      let id: string;
      try { id = decodeURIComponent(attachmentRoute[1]); }
      catch { throw new HttpInputError(400, "invalid session ID"); }
      const record = getSessionRecord(id);
      if (!record) { json(res, 404, { message: "session not found" }); return; }
      const live = runtime.getSession(id);
      if (record.closed || !live) { json(res, 409, { message: "terminal is not running" }); return; }
      if (!attachments) { json(res, 503, { message: "attachment storage unavailable" }); return; }
      const isCurrent = () => {
        const current = getSessionRecord(id);
        return Boolean(current && !current.closed && runtime.getSession(id)?.instanceId === live.instanceId);
      };
      try {
        const attachment = await attachments.receive(req, id, live.instanceId, isCurrent);
        json(res, 201, { ...attachment, insertion: planImageInsertion({ cli: runtime.getSession(id)?.cli ?? null, path: attachment.path }) });
      }
      catch (error) {
        if (error instanceof AttachmentError) json(res, error.status, { message: error.message });
        else { console.error("attachment upload failed", error); json(res, 500, { message: "could not save attachment" }); }
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/file") {
      const root = searchParams.get("root");
      const rel = searchParams.get("path") ?? "";
      if (!root || !rel) {
        text(res, 400, "root and path required");
        return;
      }
      try {
        json(res, 200, await readPreview(root, rel));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const message = err instanceof Error ? err.message : "file error";
        if (message === "path escapes workspace") text(res, 403, message);
        else if (message === "not a file") text(res, 400, message);
        else if (code === "ENOENT") text(res, 404, message);
        else if (code === "EACCES" || code === "EPERM") text(res, 403, message);
        else text(res, 500, message);
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/file/raw") {
      const root = searchParams.get("root");
      const rel = searchParams.get("path") ?? "";
      if (!root || !rel) {
        text(res, 400, "root and path required");
        return;
      }
      /*
        `download=1` 只改两件事：Content-Disposition 换成 attachment，以及**不查
        MAX_RAW_BYTES**。

        那个上限是给预览设的——inline 的东西会进 <img>/<iframe>，整份留在内存里，
        大文件能把标签页拖垮。下载走的是同一条 pipeline(createReadStream, res)，
        字节直接流去磁盘，浏览器一侧内存是常数。拿预览的理由去拦下载，等于凭空
        给「把文件取回本机」加了一个 64 MiB 的天花板。
      */
      const asAttachment = searchParams.get("download") === "1";
      try {
        const raw = await statRawFile(root, rel);
        if (!asAttachment && raw.size > MAX_RAW_BYTES) {
          text(res, 413, "file too large");
          return;
        }
        res.writeHead(200, {
          "content-type": raw.contentType,
          "content-length": raw.size,
          "content-disposition": `${asAttachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(raw.name)}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        try {
          await pipeline(createReadStream(raw.file), res);
        } catch {
          // Client aborted mid-stream; headers already sent, nothing to report.
        }
      } catch (err) {
        if (res.headersSent) return;
        const code = (err as NodeJS.ErrnoException).code;
        const message = err instanceof Error ? err.message : "file error";
        if (message === "path escapes workspace") text(res, 403, message);
        else if (message === "not a file") text(res, 400, message);
        else if (code === "ENOENT") text(res, 404, message);
        else if (code === "EACCES" || code === "EPERM") text(res, 403, message);
        else text(res, 500, message);
      }
      return;
    }

    /*
      快速切换搜文件用的整棵子树。**一次请求换掉前端那 106 次逐层请求**——
      理由和实测数字见 fs.ts 的 walkFiles。

      `root` 走上面那道闸门，所以它必须是某个终端当前的工作目录；深度和条数有硬上限，
      不接受调用方指定，免得把它变成一个可以随意遍历磁盘的接口。
    */
    if (req.method === "GET" && pathname === "/api/fs/tree") {
      const root = searchParams.get("root");
      if (!root) { text(res, 400, "root required"); return; }
      try {
        json(res, 200, await walkFiles(root));
      } catch (err) {
        const message = err instanceof Error ? err.message : "fs error";
        text(res, message === "path escapes workspace" ? 403 : 500, message);
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/fs") {
      const root = searchParams.get("root");
      const rel = searchParams.get("path") ?? "";
      if (!root) {
        text(res, 400, "root required");
        return;
    }


      try {
        json(res, 200, await listDir(root, rel));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const message = err instanceof Error ? err.message : "fs error";
        if (message === "path escapes workspace") text(res, 403, message);
        else if (code === "ENOENT") text(res, 404, message);
        else if (code === "EACCES" || code === "EPERM") text(res, 403, message);
        else if (code === "ENOTDIR") text(res, 400, message);
        else text(res, 500, message);
      }
      return;
    }
    text(res, 404, "not found");
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (err instanceof FileAccessError) {
        if (!res.headersSent) sendError(res, 403, 'root_not_allowed', err.message);
        return;
      }
      if (err instanceof ProjectNotFoundError) {
        if (!res.headersSent) json(res, 404, { code: err.code, message: "project not found" });
        return;
      }
      if (!(err instanceof HttpInputError)) console.error(err);
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : "internal error";
        text(res, err instanceof HttpInputError ? err.status : 500, message);
      }
    });
  });

  /*
    终端流开 permessage-deflate。

    Caddy 的 `encode zstd gzip` **对 upgrade 之后的连接不生效**，所以在开这个之前，
    终端输出是端到端未压缩的。而这条流恰好是压缩比最高的那种数据：JSON 包封套着
    ANSI 转义，高度重复——每帧固定约 105 字节包封，光 instanceId 那个 UUID 就占 36 字节、
    每帧重发一遍。

    实测（真起一个 ws server，数套接字上实际写出的字节；语料是 300 帧 TUI 按键重绘，
    每帧 112 字节——交互时最常见的形态）：**34.6 KB → 4.2 KB，省 87.7%**。

    用的是 ws 的默认档。两件事是实测出来、和直觉相反的，写在这里免得以后有人照直觉改：

    - **`threshold` 在这里没有作用。** 它的文档说「小于该值的载荷不压缩」，默认 1024，
      看起来 112 字节的帧一帧都压不到。实测 threshold 取 1024 和取 0 **完全一样**
      （都是 4.8 KB）。别为它加配置。
    - **压缩级别不要往下调。** level 1 是 4.8 KB，默认档是 4.2 KB——降级换来的那点 CPU
      省不下什么（服务端整条链路 p50 本来就只有 0.55ms），却多付 12% 的字节，
      而字节才是 330ms 链路上真正贵的东西。

    代价是每连接一份 zlib 上下文（约 300KB）。协商不成功时 ws 自动退回不压缩。
  */
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES, perMessageDeflate: true });
  const watchAccess = new Map<WebSocket, () => Promise<boolean>>();
  const upgrade: typeof wss.handleUpgrade = (req, socket, head, attach) => {
    const decision = authentication.authorize(req);
    if (!decision.allowed) {
      socket.end(`HTTP/1.1 ${decision.status} ${decision.status === 401 ? 'Unauthorized' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws, request) => {
      if (authentication.bindSocket(req, ws)) attach(ws, request);
    });
  };

/**
 * 从 User-Agent 里取一个**能认出是哪台设备**的短标签。
 *
 * 只留浏览器和系统，不带版本号和其余指纹——这个字符串会广播给同一会话的所有观众看，
 * 它要回答的是「另一头是我的哪台设备」，不是「这个客户端的完整身份」。
 */
function deviceLabel(agent: string | undefined): string {
  if (!agent) return "未知设备";
  const os = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android"
    : /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows"
    : /Linux/.test(agent) ? "Linux" : "";
  // 顺序要紧：Edge/Chrome 的 UA 里都含 Safari，Chrome 的里还含 Edg。
  const browser = /Edg\//.test(agent) ? "Edge" : /OPR\//.test(agent) ? "Opera"
    : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome"
    : /Safari\//.test(agent) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" · ") || "未知设备";
}

  function attachPty(ws: WebSocket, id: string, agent?: string) {
    const record = getSessionRecord(id);
    if (!record || record.closed) {
      if (ws.readyState === ws.OPEN) {
        send(ws, { type: "exit", reason: "closed" });
      }
      ws.close();
      return;
    }

    const session = runtime.getSession(id);
    if (!session) {
      if (ws.readyState === ws.OPEN) {
        send(ws, { type: "hello", pid: null, dead: true, cwd: record.cwd, cliId: null, cli: null });
      }
      return;
    }

    const clients = connections.get(id) ?? new Set<WebSocket>();
    connections.set(id, clients);
    clients.add(ws);
    viewerLabels.set(ws, deviceLabel(agent));
    /*
      同一个终端有几个观众、分别是什么设备。

      多个观众共用一个 PTY，尺寸由最后一个改的说了算，其余观众看到的排版就是错的
      （见 bb89d14）。在把那件事真正解决之前，**至少让用户看得见「另一头还有人」**
      ——否则画面莫名其妙地不对，而他手上没有任何线索。
    */
    const reportViewers = () => {
      const viewers = [...clients].map(client => ({ label: viewerLabels.get(client) ?? "未知设备" }));
      for (const client of clients) {
        if (client.readyState === client.OPEN)
          send(client, { type: "viewers", viewers, self: viewers.findIndex((_, i) => [...clients][i] === client) });
      }
    };
    const reportAppearanceOwner = () => {
      const owner = clients.values().next().value;
      for (const client of clients) {
        if (client.readyState === client.OPEN) send(client, { type: "appearance-owner", owner: client === owner });
      }
    };
    let unsubscribe = () => {};
    let started = false;
    const instanceId = runtime.getSession(id)?.instanceId;
    if (!instanceId) {
      ws.close(1011, "terminal instance unavailable");
      return;
    }
    let sentSeq = 0;

    const start = async (cursor?: { instanceId: string; seq: number }) => {
      if (started) return;
      type SocketEvent = Exclude<TerminalEvent, { type: "agent" | "command-status" }>;
      const buffered: SocketEvent[] = [];
      let bufferedBytes = 0;
      /*
        这个观众落后了：某一帧因为积压超限被丢掉，于是它手上的画面和 sentSeq 对不上了。

        不能接着发后续的 output——客户端要求 seq 连续，收到跳号会把整条流判为无效
        （frontend/src/features/terminal/resume.ts 的 accept）。所以丢过一帧之后必须**重发一份完整基线**
        才能续上。这就是 tmux 的做法：丢掉渲染、然后整屏重画，而不是丢掉流里的字节。
      */
      let behind = false;
      let latestSeq = 0;
      let resyncAt = 0;
      let resyncTimer: ReturnType<typeof setTimeout> | undefined;
      let resyncing = false;
      const failReplay = (error?: unknown) => {
        unsubscribe();
        if (ws.readyState !== ws.OPEN) return;
        const code = (error as {code?: string} | undefined)?.code;
        const reason = code === "replay_too_large" ? "terminal replay exceeds transport byte limit"
          : code === "legacy_replay_unavailable" ? "terminal replay unavailable" : "terminal replay temporarily unavailable";
        ws.close(code === "replay_too_large" ? 1009 : 1011, reason);
      };

      const deliver = (event: SocketEvent) => {
        if (ws.readyState !== ws.OPEN) return;
        if (event.type === "output") {
          if (event.instanceId !== instanceId) return;
          latestSeq = Math.max(latestSeq, event.seq);
          if (behind || event.seq <= sentSeq) { scheduleResync(); return; }
          if (send(ws, event)) sentSeq = event.seq;
          else { behind = true; scheduleResync(); }
        } else {
          send(ws, event);
          if (event.type === "exit") ws.close();
        }
      };

      function scheduleResync() {
        if (!behind || resyncTimer || resyncing || ws.readyState !== ws.OPEN) return;
        const wait = Math.max(0, resyncAt - Date.now());
        resyncTimer = setTimeout(() => { resyncTimer = undefined; void resync(); }, wait);
      }

      /*
        重新对齐：等 socket 疏通到相当空之后取一份完整基线发过去。

        两个节流是必要的，否则会来回抖：要求积压降到远低于丢弃线（不是刚好卡在线上），
        并且两次重对齐之间留一段最短间隔。tmux 用的是同一形状——每 100ms 整屏重画一次。
      */
      async function resync() {
        if (!behind || ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > RESYNC_RESUME_BYTES) { resyncAt = Date.now() + RESYNC_INTERVAL_MS; scheduleResync(); return; }
        resyncing = true;
        try {
          const baseline = await selectTerminalReplay(runtime, id);
          if (!behind || ws.readyState !== ws.OPEN) return;
          if (!baseline || baseline.instanceId !== instanceId) { failReplay(); return; }
          if (!send(ws, baseline)) return;
          sentSeq = baseline.seq;
          // Output arriving while the asynchronous replay was in flight needs
          // another complete baseline, never a gap in the output sequence.
          behind = latestSeq > sentSeq;
        } catch (error) { if ((error as {code?: string})?.code !== "replay_busy") failReplay(error); }
        finally {
          resyncing = false;
          resyncAt = Date.now() + RESYNC_INTERVAL_MS;
          scheduleResync();
        }
      }
      // Subscribe before the asynchronous replay request. Deduplicate events at
      // the replay boundary so output cannot disappear or render twice.
      const stopSubscription = runtime.subscribe(id, event => {
        // agent 事件不走这条 socket：它属于会话状态而不是终端内容，由
        // session-status 在服务端消费——那条路在没有浏览器连接时同样有效，
        // 而「你走开了」正是这个信号最有价值的时刻。
        if (event.type === "agent" || event.type === "command-status") return;
        if (started) { deliver(event); return; }
        if (event.type === "output" && event.instanceId === instanceId) latestSeq = Math.max(latestSeq, event.seq);
        bufferedBytes += Buffer.byteLength(JSON.stringify(event));
        // 首次挂载期间攒得太多：丢掉攒的这些，改走「落后」那条路——等基线发完再重对齐。
        // 掉头就掐连接的话，正在刷屏的终端会被反复杀掉重连。
        if (bufferedBytes > 4 * 1024 * 1024) { buffered.length = 0; bufferedBytes = 0; behind = true; return; }
        buffered.push(event);
      });
      // 连接关掉时顺手把重对齐的定时器也停掉，别让它拖着事件循环。
      unsubscribe = () => {
        stopSubscription();
        behind = false;
        if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = undefined; }
      };
      const deadline = Date.now() + 45_000;
      let replay;
      try {
        while (ws.readyState === ws.OPEN) {
          try { replay = await selectTerminalReplay(runtime, id, cursor); break; }
          catch (error) {
            if ((error as {code?: string})?.code !== "replay_busy" || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, RESYNC_INTERVAL_MS));
          }
        }
      } catch (error) { failReplay(error); return; }
      if (ws.readyState !== ws.OPEN) return;
      if (!replay || replay.instanceId !== instanceId) { failReplay(); return; }
      // A valid first baseline can still meet a temporarily full socket queue.
      // Retry it with a deadline instead of silently leaving the viewer waiting.
      while (!send(ws, replay)) {
        if (ws.readyState !== ws.OPEN) return;
        if (Date.now() >= deadline) { failReplay(); return; }
        await new Promise(resolve => setTimeout(resolve, RESYNC_INTERVAL_MS));
      }
      sentSeq = replay.seq;
      started = true;
      for (const event of buffered) deliver(event);
      // 挂载期间就已经落后了（攒爆了缓冲），基线发完立刻排一次重对齐。
      scheduleResync();
      if (ws.readyState === ws.OPEN) {
        send(ws, { type: "cwd", cwd: runtime.getSession(id)?.cwd ?? session.cwd });
        send(ws, { type: "cli", cli: runtime.getSession(id)?.cli ?? null });
      }
    };

    if (ws.readyState === ws.OPEN) {
      // 带上 PTY 现在的尺寸：客户端靠它才能判断自己要不要纠正，而不是以为自己上次
      // 发过就还是那样（多个观众时最后一个改的说了算，其余观众并不知情）。
      send(ws, { type: "hello", protocol: PROTOCOL_VERSION, heartbeat: 1, instanceId,
        pid: session.pid, cwd: session.cwd, cols: session.cols, rows: session.rows,
        cliId: runtime.getSession(id)?.cli ?? null, cli: wireCli(runtime.getSession(id)?.cli ?? null) });
    }
    reportAppearanceOwner();
    reportViewers();

    let incoming = Promise.resolve();
    let queuedBytes = 0;
    ws.on("message", (raw, isBinary) => {
      const bytes = Buffer.byteLength(String(raw));
      queuedBytes += bytes;
      if (queuedBytes > 4 * 1024 * 1024) { ws.terminate(); return; }
      incoming = incoming.then(async () => {
      try {
        if (ws.readyState !== ws.OPEN) return;
        if (runtime.getSession(id)?.instanceId !== instanceId) {
          send(ws, { type: "exit", reason: "replaced" });
          ws.close();
          return;
        }
        if (isBinary) {
          if (!started) return;
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
          writeSession(id, buf.toString("utf8"));
          return;
        }
        const msg = parseClientMessage(String(raw));
        if (msg.type === "ping") {
          if (started) send(ws, { type: "pong", nonce: msg.nonce! });
          return;
        }
        if (msg.type === "appearance-response") {
          if (started && msg.instanceId === instanceId && clients.values().next().value === ws) {
            (runtime.writeProtocolResponse ?? writeSession)(id, msg.data!);
          }
          return;
        }
        if (msg.type === "ready") {
          // ready only restores output; a passive/reconnecting view must not resize the shared PTY.
          await start(msg.protocol === PROTOCOL_VERSION && msg.instanceId && msg.afterSeq !== undefined
            ? { instanceId: msg.instanceId, seq: msg.afterSeq }
            : undefined);
        }
        if (msg.type === "snapshot" && typeof msg.data === "string") {
          if (started && msg.instanceId === instanceId && msg.seq !== undefined && msg.seq <= sentSeq) {
            setSnapshot(id, msg.data, instanceId, msg.seq);
          }
        }
        if (msg.type === "input" && typeof msg.data === "string") {
          if (started) writeSession(id, msg.data);
        }
        if (msg.type === "resize" && msg.cols && msg.rows) {
          resizeSession(id, msg.cols, msg.rows);
        }
      } catch {
        ws.close(1008, "invalid terminal message");
      } finally { queuedBytes -= bytes; }
      });
    });
    ws.on("close", () => {
      try {
        unsubscribe();
        clients.delete(ws);
        viewerLabels.delete(ws);
        reportAppearanceOwner();
        reportViewers();
        if (clients.size === 0) {
          connections.delete(id);
          void Promise.resolve(runtime.flush(id)).catch(error => console.error("terminal flush failed", error));
        }
      } catch (error) {
        console.error("terminal cleanup failed", error);
      }
    });
  }

  /**
   * 把一个根目录的变更推给一条连接。这条流是只读的：客户端发任何东西都会被断开，
   * 和 session-status 那条一样——它没有需要告诉我们的事。
   */
  function attachFileWatch(ws: WebSocket, root: string, requestedRoot = root) {
    let stop: (() => void) | null = null;
    const authorized = async () => {
      try {
        if (await allowedFileRoot(requestedRoot) === root && ws.readyState === ws.OPEN) return true;
      } catch { /* Deleted terminal, changed cwd or replaced root revokes the subscription. */ }
      ws.close(1008, 'file root no longer authorized');
      return false;
    };
    watchAccess.set(ws, authorized);
    const send = () => {
      if (ws.readyState !== ws.OPEN) return;
      void authorized().then(ok => {
        if (ok) ws.send(JSON.stringify({ type: "files-changed", root: requestedRoot }));
      }).catch(() => ws.terminate());
    };
    try {
      stop = fileWatcher.watch(root, send, () => ws.close(1011, "watch unavailable"));
    } catch {
      // 目录没了或系统不支持递归监听：明确告诉客户端，让它退回手动刷新，
      // 而不是握着一条永远不会说话的连接。
      ws.close(1011, "watch unavailable");
      watchAccess.delete(ws);
      return;
    }
    const detach = () => { stop?.(); stop = null; watchAccess.delete(ws); };
    ws.on("close", detach);
    ws.on("error", () => { detach(); ws.terminate(); });
    ws.on("message", () => ws.close(1008, "read-only stream"));
  }

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    try {
      if (!checkAccess(req).allowed) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const authDecision = authentication.authorize(req);
      if (!authDecision.allowed) {
        socket.end(`HTTP/1.1 ${authDecision.status} ${authDecision.status === 401 ? 'Unauthorized' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const conversationStream = url.pathname.match(/^\/api\/conversations\/([^/]+)\/stream$/);
      if (conversationStream) {
        const id = decodeURIComponent(conversationStream[1]);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)
          || [...url.searchParams.keys()].some(key => key !== "cursor" || url.searchParams.getAll(key).length !== 1)
          || (cursor !== undefined && (!cursor || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) {
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        upgrade(req, socket, head, ws => conversationMessaging.attach(ws, id, { cursor }));
        return;
      }
      const aiEvents = url.pathname.match(/^\/api\/ai-sessions\/([^/]+)\/events$/);
      if (aiEvents) {
        try {
          const id = decodeURIComponent(aiEvents[1]);
          const after = url.searchParams.get("afterSeq");
          const cursor = after === null ? 0 : /^\d+$/.test(after) ? Number(after) : NaN;
          aiBridge.read(id, cursor, url.searchParams.get("generation") ?? undefined);
          upgrade(req, socket, head, ws => {
            const clients = aiConnections.get(id) ?? new Set<WebSocket>();
            clients.add(ws); aiConnections.set(id, clients);
            ws.once("close", () => { clients.delete(ws); if (!clients.size) aiConnections.delete(id); });
            attachAiSessionStream(ws, aiBridge, id, cursor, url.searchParams.get("generation") ?? undefined, () => aiSyncStatus(id), runtime);
          });
        } catch (error) {
          const status = error instanceof AiSessionBridgeError && [404,409].includes(error.status) ? error.status : 400;
          socket.end(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        }
        return;
      }
      if (url.pathname === "/api/session-status") {
        upgrade(req, socket, head, ws => sessionStatus.attach(ws));
        return;
      }
      if (url.pathname === "/api/files/watch") {
        const root = url.searchParams.get("root");
        if (!root || url.searchParams.getAll('root').length !== 1) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        void allowedFileRoot(root).then(canonical => {
          if (!socket.destroyed) upgrade(req, socket, head, ws => attachFileWatch(ws, canonical, root));
        }).catch(() => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
        return;
      }
      if (url.pathname !== "/api/pty") {
        socket.destroy();
        return;
      }
      const id = url.searchParams.get("id");
      if (!id) {
        socket.destroy();
        return;
      }
      upgrade(req, socket, head, (ws) => {
        ws.on("error", () => {
          if (ws.readyState === ws.OPEN) ws.close(1011, "terminal connection failed");
        });
        try {
          attachPty(ws, id, req.headers["user-agent"]);
        } catch {
          ws.close(1011, "terminal connection failed");
        }
      });
    } catch {
      socket.destroy();
    }
  });

  const detachDisconnect = runtime.onDisconnect?.(() => {
    for (const clients of connections.values()) for (const ws of clients) ws.terminate();
  });
  let scanning = false;
  let closing = false;
  const scanTimer = setInterval(() => {
    if (scanning || closing) return;
    scanning = true;
    void runtime.scanLiveSessions().then(() => {
      if (closing) return;
      for (const record of store.loadWorkspace().sessions) {
        const live = runtime.getSession(record.id);
        if (live && live.cwd !== record.cwd) store.setSessionCwd(record.id, live.cwd);
      }
      for (const check of watchAccess.values()) void check();
    }).catch((error) => { if (!closing) console.error("terminal scan failed", error); })
      .finally(() => { scanning = false; });
  }, 2500);
  scanTimer.unref();
  // Closing transport does not dispose injected owners. The application closes
  // injected owners independently. A daemon client disconnect preserves PTYs.
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    closing = true;
    serverMonitor.dispose();
    subscriptions.dispose();
    conversationMessaging.dispose();
    authentication.dispose();
    claudeObserver.dispose();
    aiTranscriptSource.dispose();
    aiAgentSource.dispose();
    sessionStatus.dispose();
    fileWatcher.dispose();
    watchAccess.clear();
    detachDisconnect?.();
    clearInterval(scanTimer);
    for (const clients of connections.values()) for (const ws of clients) ws.terminate();
    wss.close();
    return close(callback);
  }) as typeof server.close;
  return server;
}
