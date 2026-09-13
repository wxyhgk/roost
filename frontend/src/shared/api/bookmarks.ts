import { request } from "./request";
import type { Conversation } from './conversations';

/** 收藏的一条 AI 对话：记下「哪条、在哪个目录、怎么接着跑」。存的是快照，不是引用。 */
export type Bookmark = {
  id: string;
  groupId: string | null;
  cliId: string;
  nativeSessionId: string;
  cwd: string | null;
  title: string;
  note: string | null;
  seq: number;
  createdAt: number;
};
export type BookmarkGroup = { id: string; name: string; seq: number };
export type BookmarkBoard = { groups: BookmarkGroup[]; cards: Bookmark[] };

const send = (method: string, path: string, body?: unknown) =>
  request<BookmarkBoard>(path, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const fetchBookmarks = () => request<BookmarkBoard>("/api/bookmarks");
export const fetchBookmarkConversation = (id: string) => request<Conversation | null>(`/api/bookmarks/${encodeURIComponent(id)}/conversation`);
export const addBookmark = (card: Pick<Bookmark, "id" | "cliId" | "nativeSessionId" | "cwd" | "title"> & { groupId?: string | null; note?: string | null }) =>
  request<Bookmark>("/api/bookmarks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(card) });
export const patchBookmark = (id: string, patch: { title?: string; note?: string | null; groupId?: string | null; beforeId?: string | null }) =>
  send("PATCH", `/api/bookmarks/${encodeURIComponent(id)}`, patch);
export const removeBookmark = (id: string) => send("DELETE", `/api/bookmarks/${encodeURIComponent(id)}`);
export const addBookmarkGroup = (id: string, name: string) =>
  request<BookmarkGroup>("/api/bookmarks/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name }) });
export const patchBookmarkGroup = (id: string, patch: { name?: string; beforeId?: string | null }) =>
  send("PATCH", `/api/bookmarks/groups/${encodeURIComponent(id)}`, patch);
export const removeBookmarkGroup = (id: string) => send("DELETE", `/api/bookmarks/groups/${encodeURIComponent(id)}`);
