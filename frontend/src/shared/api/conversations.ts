import { request } from "./request";
import type { HistoryMessage, HistoryCoverage, Delivery } from "./conversationPayloads";
import { socketUrl } from "../runtime";

/**
 * 对话目录：独立于终端存在。终端关掉、CLI 退出，对话仍然留在这里可读。
 *
 * 只读历史——**打开一个对话不会启动任何 CLI**，也不会去读它的原生文件。
 */

export type ConversationSource = {
  id: string;
  conversationId: string;
  legacyConversationId: string;
  cliId: string;
  nativeSessionId: string;
  cwd: string | null;
  transcriptPath: string | null;
  observedAt: number;
  coverage?: { hasGap?: boolean } | null;
};

export type Conversation = {
  id: string;
  title: string;
  /** 标题从哪来：CLI 原生的、用户改过的、还是兜底生成的。 */
  titleOrigin: "native" | "user" | "fallback";
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  archivedAt: number | null;
  trashedAt: number | null;
  pinnedAt: number | null;
  revision: number;
  forkedFromId: string | null;
  source: ConversationSource;
  /**
   * 这条对话的第一条用户消息（后端截到 120 字）。
   *
   * **只有列表接口给**，`fetchConversation` 单取一条时没有——所以是可选的，不能当成
   * 一定存在。目录里几乎所有标题都是兜底值（终端一律叫「Terminal」），这一句才是
   * 「这条对话讲了什么」的唯一线索。
   */
  firstUserMessagePreview?: string | null;
};

export type ConversationState = "active" | "archived" | "trashed" | "all";
export type ConversationFilters = {
  q?: string; state?: ConversationState; projectId?: string | null;
  /** 查这个终端**曾经**承载过哪些对话。终端记录已删除仍保留关联。 */
  terminalId?: string;
  /**
   * created（默认）按创建时间；activity 按最后一条已保存消息的时间。
   *
   * 目录最主要的用途是「找回刚才那条」，所以界面默认用 activity——
   * 按创建时间排会让昨天建、五分钟前刚用过的对话沉在底下。
   */
  sort?: "created" | "activity";
};
export type ConversationPage = { items: Conversation[]; nextCursor: string | null };

/** 后端上限；超过会 400，本地先夹住免得白跑一趟。 */
export const MAX_QUERY_LENGTH = 200;
export const MAX_PAGE_SIZE = 200;

/** 按 ID 取单条。偏好里只存 ID，刷新之后要靠它把详情恢复出来。 */
export function fetchConversation(conversationId: string) {
  return request<Conversation>(`/api/conversations/${encodeURIComponent(conversationId)}`);
}

export function listConversations(
  filters: ConversationFilters = {},
  cursor?: string | null,
  limit = 30,
): Promise<ConversationPage> {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q.slice(0, MAX_QUERY_LENGTH));
  if (filters.state && filters.state !== "active") params.set("state", filters.state);
  if (filters.projectId !== undefined) params.set("projectId", filters.projectId === null ? "null" : filters.projectId);
  if (filters.terminalId) params.set("terminalId", filters.terminalId);
  if (filters.sort && filters.sort !== "created") params.set("sort", filters.sort);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(Math.min(Math.max(limit, 1), MAX_PAGE_SIZE)));
  return request<ConversationPage>(`/api/conversations?${params}`);
}

export type HistoryPage = {
  conversationId: string;
  items: HistoryMessage[];
  /** 往**更早**翻：快照返回的是最新一页，分页倒着走。 */
  nextCursor: string | null;
  hasMore: boolean;
  historyEpoch: string;
  upperBoundSeq: number;
  coverage: HistoryCoverage;
};

/** snapshot.run：快照当时看到的运行。为空仍然可以照常阅读历史。 */
export type SnapshotRun = {
  webSessionId?: string;
  terminalInstanceId?: string;
  [key: string]: unknown;
} | null;

export type ConversationSnapshot = {
  conversation: Conversation;
  messages: HistoryPage;
  inbox: { items: unknown[]; nextCursor: string | null };
  outbox: { items: unknown[]; nextCursor: string | null };
  run: SnapshotRun;
  /** stream 专用游标。**不能**拿消息分页的 nextCursor 当它用。 */
  cursor: string;
};

export const CONVERSATION_REQUEST_TIMEOUT_MS = 45_000;
function readOptions(signal?: AbortSignal): RequestInit {
  const timeout = AbortSignal.timeout(CONVERSATION_REQUEST_TIMEOUT_MS);
  return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
}

export function fetchSnapshot(conversationId: string, signal?: AbortSignal) {
  return request<ConversationSnapshot>(`/api/conversations/${encodeURIComponent(conversationId)}/snapshot`, readOptions(signal));
}

/** 往更早翻一页历史。 */
export function fetchMessages(conversationId: string, cursor?: string | null, limit = 30, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return request<HistoryPage>(`/api/conversations/${encodeURIComponent(conversationId)}/messages?${params}`, readOptions(signal));
}

/** stream 的变更只给消息 ID，正文要按 ID 回读。 */
export function fetchMessage(conversationId: string, messageId: string, signal?: AbortSignal) {
  return request<HistoryMessage>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`, readOptions(signal));
}

export type ConversationChange = { seq: number; kind: string; entityId: string; entityRevision?: number };
export type StreamFrame =
  | { type: "changes"; items: ConversationChange[]; cursor: string; hasMore: boolean }
  | { type: "error"; status: number; error: { code: string; message: string } };

export type ConversationStreamHandlers = {
  onChanges: (items: ConversationChange[], cursor: string) => void;
  onResync: () => void;
  onClosed: () => void;
  onOpen?: () => void;
};

/**
 * 订阅一个对话的变更。
 *
 * 网关重启会换 epoch，旧游标返回 `resync_required`——那时必须**重新取快照**，
 * 不能拿着旧游标无限重试。这条由 onResync 交给调用方处理。
 */
export function connectConversationStream(
  conversationId: string,
  cursor: string,
  handlers: ConversationStreamHandlers,
): () => void {
  const url = socketUrl(`/api/conversations/${encodeURIComponent(conversationId)}/stream`);
  url.searchParams.set("cursor", cursor);
  let disposed = false;
  let socket: WebSocket | null = null;
  try { socket = new WebSocket(url.toString()); } catch { handlers.onClosed(); return () => { disposed = true; }; }
  const current = socket;
  const handshake = setTimeout(() => lost(), CONVERSATION_REQUEST_TIMEOUT_MS);
  current.onopen = () => {
    if (disposed) return;
    clearTimeout(handshake);
    handlers.onOpen?.();
  };
  current.onmessage = event => {
    if (disposed) return;
    let frame: StreamFrame;
    try { frame = JSON.parse(String(event.data)) as StreamFrame; } catch { return; }
    if (frame.type === "changes") handlers.onChanges(frame.items, frame.cursor);
    else if (frame.type === "error") {
      if (frame.error?.code === "resync_required") { stop(); handlers.onResync(); }
      else lost();
    }
  };
  const stop = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(handshake);
    current.onopen = current.onmessage = current.onclose = current.onerror = null;
    current.close();
  };
  const lost = () => { if (!disposed) { stop(); handlers.onClosed(); } };
  current.onclose = lost;
  current.onerror = lost;
  return stop;
}

export type PeerMessage = { id: string; requestId: string; text?: string; preview?: string; truncated?: boolean; createdAt: number };
export type PeerDetail = { message: PeerMessage; delivery: Delivery };
export type PeerPage = { items: PeerDetail[]; nextCursor: string | null };

/**
 * 发一条消息给这个对话的 CLI。
 *
 * **202 只代表已保存并排队**，不代表 CLI 收到了——真实状态看返回体里的
 * `delivery.state`。requestId 由调用方生成并在重试时**沿用**：后端按它做幂等，
 * 同 ID 同正文会返回原来那条，同 ID 不同正文返回 409 request_conflict。
 */
export function sendToConversation(conversationId: string, requestId: string, text: string) {
  return request<PeerDetail>(`/api/conversations/${encodeURIComponent(conversationId)}/inbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, text }),
  });
}

export function fetchInbox(conversationId: string, limit = 20, signal?: AbortSignal) {
  return request<PeerPage>(`/api/conversations/${encodeURIComponent(conversationId)}/inbox?limit=${limit}`, readOptions(signal));
}

/** 只有 queued 能取消；其余返回 409 already_dispatching，应当回读最新状态。 */
export function cancelDelivery(deliveryId: string) {
  return request<PeerDetail>(`/api/peer-deliveries/${encodeURIComponent(deliveryId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function fetchPeerMessage(messageId: string, signal?: AbortSignal) {
  return request<PeerDetail>(`/api/peer-messages/${encodeURIComponent(messageId)}`, readOptions(signal));
}


/** 当前已核验的位置。只在用户点「定位」时调用。 */
export type VerifiedRuntime = {
  conversationId: string;
  runId: string;
  webSessionId: string;
  terminalInstanceId: string;
  generation: string;
  cliId: string;
  nativeSessionId: string;
  runtimeVerified: true;
};

/**
 * 向 daemon 核验这条对话此刻跑在哪。
 *
 * 200 **只代表这一次查询观察到的位置**，之后仍可能变化——不能缓存成长期的
 * 「在线证明」。跳转时要核对连接上的 terminalInstanceId，不匹配就重新查询，
 * 绝不静默连到同 ID 的新实例上。
 *
 * 旧 daemon 返回 503 `runtime_unavailable`：那是「暂时定位不了」，
 * **不是**「对话不存在」，界面必须分开说。
 */
export function locateRuntime(conversationId: string) {
  return request<VerifiedRuntime>(`/api/conversations/${encodeURIComponent(conversationId)}/runtime`);
}

/**
 * 问 daemon：这个终端**此刻**跑的是哪条对话。
 *
 * 与 `locateRuntime` 是同一件事的两个方向，返回同一形状。
 * 200 只是这一次查询的观察，不是长期在线证明。
 *
 * 409 `run_unavailable` 表示「还没识别出结构化对话」——**不能**退而求其次去
 * `?terminalId=` 的历史列表里取第一条当作当前身份，那是过去的关联不是现在的。
 * 那份历史只能拿来**读**：可以据它打开一条对话看内容，但绝不能据它投递消息。
 */
export function fetchTerminalConversation(terminalId: string) {
  return request<VerifiedRuntime>(`/api/sessions/${encodeURIComponent(terminalId)}/conversation`);
}

export type ConversationPatch = {
  title?: string;
  /** 归入哪个分组。null 表示不属于任何分组。 */
  projectId?: string | null;
  pinned?: boolean;
  archived?: boolean;
  trashed?: boolean;
};

/**
 * 修改一条对话。
 *
 * 用 revision 做乐观并发：**409 时响应体带着 `current`**，那是服务端此刻的真实值。
 * 必须拿它去更新界面并让用户在新值上重做，不能静默覆盖。
 */
export function patchConversation(conversationId: string, revision: number, patch: ConversationPatch) {
  return request<Conversation>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, ...patch }),
  });
}

/** 一条终端的 AI 绑定。只取重新绑定用得上的几个字段。 */
export type AiBinding = {
  webSessionId: string;
  terminalInstanceId: string;
  cliId: string;
  nativeSessionId: string;
  generation: string;
  revision: number;
};

export function fetchAiBinding(terminalId: string) {
  return request<{ binding: AiBinding }>(`/api/ai-sessions/${encodeURIComponent(terminalId)}`);
}

/**
 * 把绑定挪到当前活着的那条 PTY 上。
 *
 * **服务端不猜身份**：它拿 `terminalInstanceId` 去读那条 PTY 自己的日志，只有 CLI 已经报过
 * 的身份和你声称的 `nativeSessionId` 对得上才写入。所以这不是「替用户认领一个对话」，
 * 是「把 CLI 早就说过的话读出来」。认不出时返回 409 `identity_unconfirmed`。
 *
 * 用 generation + revision 做乐观并发。**revision 涨得很快**（实测约 1 次/秒，transcript
 * 摄取一直在写），而这个请求要走「读绑定 → 读日志核验 → 写入」整条链，几百毫秒足够它变一次
 * ——所以调用方必须重试，见 `rebindWithRetry`。
 */
export function rebindAiSession(terminalId: string, body: {
  expectedGeneration: string; expectedRevision: number;
  terminalInstanceId: string; cliId: string; nativeSessionId: string;
}) {
  return request<{ binding: AiBinding }>(`/api/ai-sessions/${encodeURIComponent(terminalId)}/rebind`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
