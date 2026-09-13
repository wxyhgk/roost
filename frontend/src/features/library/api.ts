import { errorText, t } from "@roost/i18n";
export type Kind = "notes" | "snippets";
export type Content = { text: string } | { title: string; lang: string; code: string };
export type RecordData = { id: string; revision: number; createdAt: number; updatedAt: number; deletedAt: number | null; text?: string; title?: string; lang?: string; code?: string };
export type Summary = { id: string; title: string; summary: string; revision: number; createdAt: number; updatedAt: number; lang?: string };
export type Page = { items: Summary[]; nextCursor: string | null };
export class LibraryError extends Error {
  constructor(public status: number, message: string, public current?: RecordData) { super(message); }
}
export type Transport = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export const request: Transport = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new LibraryError(0, t.library.error.connection); }
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { /* Host/Origin errors may be plain text. */ }
  if (!response.ok) {
    const code = typeof data?.error?.code === "string" ? data.error.code : null;
    // 纯文本兜底只接受像一句话的内容，避免把代理的 HTML 错误页糊到界面上。
    const plain = !data && text && text.length <= 200 && !text.includes("<") ? text : null;
    const serverMessage = typeof data?.error?.message === "string" ? data.error.message : plain;
    throw new LibraryError(response.status, errorText(code, response.status, serverMessage), data?.current);
  }
  if (data === undefined) throw new LibraryError(502, t.library.error.invalidData);
  return data as T;
};
export function content(kind: Kind, r: RecordData): Content {
  return kind === "notes" ? { text: r.text ?? "" } : { title: r.title ?? "", lang: r.lang ?? "plaintext", code: r.code ?? "" };
}
export function same(kind: Kind, a: RecordData, b: RecordData) { return JSON.stringify(content(kind, a)) === JSON.stringify(content(kind, b)); }
export function uid(): string {
  // crypto.randomUUID 仅在安全上下文（HTTPS 或 localhost）下存在；经 http 端口映射
  // 访问时它是 undefined，直接调用会抛错并让整个资料库不可用。
  // getRandomValues 没有这个限制，用它拼一个符合 RFC 4122 的 v4 UUID。
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const message = (e: unknown) => e instanceof Error ? e.message : t.library.error.fallback;
