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
export const message = (e: unknown) => e instanceof Error ? e.message : t.library.error.fallback;
