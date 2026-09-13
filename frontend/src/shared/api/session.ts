import type { Project, Session } from "../types";
import { request } from "./request";
import { stableRuntime, coreUrl } from '../runtime';
import { t } from "@roost/i18n";

export type WorkspaceSnapshot = {
  sessions: Session[];
  projects: Project[];
  selectedId: string | null;
  expandedProjectIds: string[];
  pinnedSessionIds: string[];
  /** 当前选中的长期对话。**与 selectedId（终端选择）分开保存**，不随终端切换而变。 */
  selectedConversationId: string | null;
  /** 仅仅是 UI 偏好：置为 true 不会让后端替你猜一条对话，跟随行为由前端显式实现。 */
  followTerminalConversation: boolean;
  sessionSeq: number;
  projectSeq: number;
};

export function fetchWorkspace(signal?: AbortSignal) {
  if (stableRuntime) return fetchCoreWorkspace(signal);
  return request<WorkspaceSnapshot>("/api/workspace", { signal, cache: 'no-store' });
}

let metadata: WorkspaceSnapshot | null = null;
let metadataPending = false;
async function fetchCoreWorkspace(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  // Metadata is optional and must never delay discovery of live terminals.
  if (!metadataPending) {
    metadataPending = true;
    const deadline = AbortSignal.timeout(3000);
    void request<WorkspaceSnapshot>('/api/workspace', { signal: signal ? AbortSignal.any([signal, deadline]) : deadline })
      .then(value => { if (!signal?.aborted) metadata = value; }).catch(() => undefined).finally(() => { metadataPending = false; });
  }
  const deadline = AbortSignal.timeout(4000);
  const response = await fetch(coreUrl('/api/core/sessions'), { cache: 'no-store', signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  if (!response.ok) throw Error(t.misc.session.coreUnavailable(response.status));
  const { sessions: live } = await response.json() as { sessions: Array<{ id: string; cwd: string; cli: Session['cli']; cliId?: string | null }> };
  const sessions: Session[] = live.map(item => {
    const saved = metadata?.sessions.find(s => s.id === item.id);
    return { ...saved, id: item.id, cwd: item.cwd, cli: item.cli, cliId: item.cliId, closed: false,
      title: saved?.title ?? item.cwd.split('/').filter(Boolean).at(-1) ?? item.id, projectId: saved?.projectId ?? null };
  });
  return { sessions, projects: metadata?.projects ?? [], selectedId: sessions.find(s => s.id === metadata?.selectedId)?.id ?? sessions[0]?.id ?? null,
    expandedProjectIds: metadata?.expandedProjectIds ?? [], pinnedSessionIds: metadata?.pinnedSessionIds ?? [],
    selectedConversationId: metadata?.selectedConversationId ?? null,
    followTerminalConversation: metadata?.followTerminalConversation ?? false,
    sessionSeq: sessions.length, projectSeq: metadata?.projectSeq ?? 0 };
}

export function patchWorkspace(body: {
  selectedId?: string | null;
  expandedProjectIds?: string[];
  pinnedSessionIds?: string[];
  selectedConversationId?: string | null;
  followTerminalConversation?: boolean;
}) {
  return request<WorkspaceSnapshot>("/api/workspace", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function createSession(body?: {
  id?: string;
  cwd?: string;
  title?: string;
  projectId?: string | null;
  closed?: boolean;
}) {
  return request<Session>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export function closeSession(id: string) {
  return request<WorkspaceSnapshot>(
    `/api/sessions/${encodeURIComponent(id)}/close`,
    { method: "POST" },
  );
}

export function reopenSession(id: string, resume = false) {
  return request<WorkspaceSnapshot>(
    `/api/sessions/${encodeURIComponent(id)}/reopen`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resume }) },
  );
}

/** 「这个终端原来跑的那条 AI 对话，还能不能接着跑」。命令由服务端拼，前端只负责展示它。 */
export type ResumePlan =
  | { available: true; cliId: string; cliName: string; nativeSessionId: string; command: string[] }
  | { available: false; reason: string };

export function fetchResumePlan(id: string, signal?: AbortSignal) {
  return request<ResumePlan>(`/api/sessions/${encodeURIComponent(id)}/resume`, { signal, cache: 'no-store' });
}

export function killSession(id: string) {
  return request<WorkspaceSnapshot>(
    `/api/sessions/${encodeURIComponent(id)}/kill`,
    { method: "POST" },
  );
}

/**
 * 备注长度上限，单位是 UTF-16 码元（JavaScript 的 `.length`）。
 *
 * 这个单位是后端契约明确指定的，就是为了和 HTML `maxlength` 对齐——所以输入框
 * 直接写 `maxLength={NOTE_MAX}` 就和服务端校验完全一致，不会出现「浏览器让你打完、
 * 服务端却退回 400」。超长后端**不截断**，直接 400。
 */
export const NOTE_MAX = 2000;

export function patchSession(
  id: string,
  /** note 传 null 或 "" 都表示清空；**不能省略这个键**，省略是「不改」。 */
  body: { projectId?: string | null; title?: string; note?: string | null; beforeId?: string | null },
) {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function patchProject(id: string, body: { name?: string; beforeId?: string | null }) {
  return request<Project>(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function createProject(body?: { id?: string; name?: string; color?: string }) {
  return request<Project>("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export function deleteProject(id: string) {
  return request<WorkspaceSnapshot>(
    `/api/projects/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export function ptyUrl(id: string) {
  if (stableRuntime) return coreUrl(`/api/core/pty?id=${encodeURIComponent(id)}`).replace(/^http:/, 'ws:');
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/pty?id=${encodeURIComponent(id)}`;
}
