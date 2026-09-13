import { request } from "./request";
import { ApiError, apiErrorFrom } from "./errors";
import { errorText, t } from "@roost/i18n";

export type FileNode = {
  name: string;
  kind: "file" | "dir";
  path: string;
};

export type FilePreview = {
  name: string;
  path: string;
  binary: boolean;
  truncated: boolean;
  content: string;
  mtime: number;
};

/*
  超时不在这里定：`request()` 给所有请求兜了一道 45 秒的截止时间，并且会把调用方
  传进来的 signal 和它合并。这里只负责把 signal 传下去——effect 清理时要中止的是
  「这一次」请求，和那道兜底是两个理由。
*/
export function readFilePreview(root: string, relPath: string, signal?: AbortSignal) {
  const q = new URLSearchParams({ root, path: relPath });
  return request<FilePreview>(`/api/file?${q}`, { signal });
}

// Binary originals (images, PDFs) for <img>/<iframe>; streamed by the backend
// with an inline content type, works through the Vite /api proxy.
export function rawFileUrl(root: string, relPath: string) {
  const q = new URLSearchParams({ root, path: relPath });
  return `/api/file/raw?${q}`;
}

/**
 * 同一个字节流，但让浏览器存盘而不是内嵌显示。
 *
 * 后端在 `download=1` 时换成 `attachment`，并跳过那个只对预览有意义的 64 MiB 上限。
 */
export function downloadFileUrl(root: string, relPath: string) {
  const q = new URLSearchParams({ root, path: relPath, download: "1" });
  return `/api/file/raw?${q}`;
}

export type FileWriteConflict = FilePreview & { message: string };

export class FileWriteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly current?: FileWriteConflict,
  ) {
    super(message);
  }
}

export async function writeFile(
  root: string,
  relPath: string,
  content: string,
  mtime: number,
): Promise<{ mtime: number }> {
  const res = await fetch("/api/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root, path: relPath, content, mtime }),
  });
  if (!res.ok) {
    const failure = await apiErrorFrom(res);
    // 409 的响应体同时带着当前磁盘内容与 mtime，冲突界面要用。
    const current = res.status === 409 && failure.body
      ? ({ ...failure.body, message: failure.message } as unknown as FileWriteConflict)
      : undefined;
    throw new FileWriteError(res.status, failure.message, current);
  }
  return res.json() as Promise<{ mtime: number }>;
}

/**
 * 快速切换搜文件用的整棵子树。
 *
 * 以前这是前端逐层 `listDir`：实测这个仓库 106 个请求、6 层串行，光往返就 2 秒
 * （HTTP/1.1 上近 6 秒）。服务端一次走完是本地磁盘操作，毫秒级。深度和条数由服务端
 * 定死，这里不传——它不该是一个可以指定范围的遍历接口。
 */
export function walkTree(root: string, signal?: AbortSignal) {
  const q = new URLSearchParams({ root });
  return request<{ files: { path: string; name: string }[]; truncated: boolean }>(`/api/fs/tree?${q}`, { signal });
}

export function listDir(root: string, relPath = "", signal?: AbortSignal) {
  const q = new URLSearchParams({ root, path: relPath });
  return request<FileNode[]>(`/api/fs?${q}`, { signal });
}

async function fsRequest<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/fs", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiErrorFrom(res);
  return res.json() as Promise<T>;
}

export function createPath(root: string, relPath: string, kind: "file" | "dir") {
  return fsRequest<{ name: string; path: string }>("POST", { root, path: relPath, kind });
}

export function renamePath(root: string, relPath: string, newPath: string) {
  return fsRequest<{ name: string; path: string }>("PATCH", { root, path: relPath, newPath });
}

export function deletePath(root: string, relPath: string) {
  return fsRequest<{ ok: true }>("DELETE", { root, path: relPath });
}

/** 同名文件的处理方式。契约见 tasks/file-upload-plan.md。 */
export type UploadConflict = "error" | "rename" | "overwrite";
export type UploadResult = {
  name: string; path: string; size: number; mtime: number;
  /** 只有显式覆盖才会为 true；自动改名不算覆盖。 */
  overwritten: boolean;
};

/** 单文件上限，与后端一致（64 MiB）。超了就别发，省得白传一遍再被拒。 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * 上传一个文件到工作目录。
 *
 * 用 XHR 而不是 fetch：**fetch 至今没有上传进度**。多兆文件经隧道要好几秒，
 * 没有进度条时用户分不清「在传」和「卡死了」。
 *
 * 请求体是裸字节，不包 JSON、不包 multipart——二进制走 JSON 会膨胀数倍。
 */
export function uploadFile(
  root: string,
  relPath: string,
  file: Blob,
  options: { conflict?: UploadConflict; signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {},
): Promise<UploadResult> {
  const query = new URLSearchParams({ root, path: relPath, conflict: options.conflict ?? "error" });
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/fs/file?${query}`);
    xhr.responseType = "text";
    const abort = () => xhr.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const done = () => options.signal?.removeEventListener("abort", abort);

    xhr.upload.onprogress = event => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      done();
      let body: Record<string, unknown> | null = null;
      try { body = JSON.parse(xhr.responseText) as Record<string, unknown>; } catch { /* 非 JSON 走下面的兜底 */ }
      if (xhr.status >= 200 && xhr.status < 300 && body) { resolve(body as unknown as UploadResult); return; }
      const failure = (body?.error ?? null) as { code?: unknown; message?: unknown } | null;
      const code = typeof failure?.code === "string" ? failure.code : null;
      const serverMessage = typeof failure?.message === "string" ? failure.message : null;
      reject(new ApiError(xhr.status, code, errorText(code, xhr.status, serverMessage), serverMessage, body));
    };
    // 网络中断和被 abort 都走这里：状态码为 0，没有服务端说法可用。
    xhr.onerror = () => { done(); reject(new ApiError(0, null, t.misc.request.offline, null, null)); };
    xhr.onabort = () => { done(); reject(new DOMException("aborted", "AbortError")); };
    xhr.send(file);
  });
}
