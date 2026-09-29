import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_HTTP_BYTES = 1024 * 1024;

export class HttpInputError extends Error {
  constructor(public readonly status: 400 | 413, message: string) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readJson(req: IncomingMessage, maxBytes = MAX_HTTP_BYTES): Promise<Record<string, unknown>> {
  // Consume via events so rejecting a body does not destroy the response socket.
  const body = await new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        reject(new HttpInputError(413, "request body too large"));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    req.on("aborted", () => reject(new HttpInputError(400, "request aborted")));
  });
  if (!body) return {};
  let value: unknown;
  try { value = JSON.parse(body); } catch {
    throw new HttpInputError(400, "invalid JSON");
  }
  if (!isObject(value)) throw new HttpInputError(400, "JSON object required");
  return value;
}

// Public API codes: additions are compatible; renaming an existing code is not.
export type ApiErrorCode =
  | "root_not_allowed"
  | "invalid_request" | "too_large" | "internal_error" | "storage_unavailable"
  | "not_found" | "conflict" | "method_not_allowed" | "unsupported_media_type"
  | "request_timeout" | "file_conflict" | "binary_file" | "not_file"
  | "path_escape" | "permission_denied"
  | "request_conflict" | "queue_full" | "already_writing" | "sending_disabled" | "control_unavailable" | "target_changed"
  | "no_conversation" | "unsupported_cli" | "unusable_session_id" | "identity_syncing"
  | "source_unavailable" | "terminal_changed" | "source_gap" | "source_changed" | "identity_unconfirmed" | "upload_busy"
  /* 从对话直接把 CLI 跑起来时的两种拒绝。 */
  | "conversation_trashed" | "already_running";

export function sendError(
  res: ServerResponse, status: number, code: ApiErrorCode, message: string,
  extra: Record<string, unknown> = {},
) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ ...extra, error: { code, message } }));
}

/*
  单段 Range 解析。**媒体播放全靠它。**

  `<video>`/`<audio>` 不会像 `<img>` 那样整份下完再播：它先要头部的几百 KB 拿到时长和
  索引，拖进度条时再按字节区间要中间那一段。服务端只会 200 全量的话，进度条拖不动；
  而 **iPad 上的 Safari 更严格——拿不到 206 它根本不开始播**，界面上就是一个点不动的
  播放器，且不报任何错。

  只认单段。`bytes=0-99,200-299` 这种多段要 multipart/byteranges 才能回，而浏览器
  播放器从不发多段；按规范，不理解的 Range 可以当作没有 Range、回 200 全量，所以这里
  对多段返回 null（=全量），不是错误。

  返回 `"unsatisfiable"` 的情形要回 416 并带上 `content-range: bytes *\/<size>`，
  播放器据此知道自己问过头了。**空文件的任何区间都不可满足**——0 字节没有第 0 个字节。
*/
export type ByteRange = { start: number; end: number };
export function parseByteRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    // 后缀区间：最后 N 个字节。N 比文件还大时给整份，这是规范要求的，不是错误。
    const wanted = Number(rawEnd);
    if (!Number.isSafeInteger(wanted)) return null;
    if (wanted === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return null;
  // 起点越过文件尾。**这一行是冗余的**——末端夹到 size-1 之后，下面 `end < start` 会得出
  // 同样的结论（变异测试逐个输入验过，结果完全一致）。留着是因为它把 416 的理由直接说了
  // 出来；改动时别以为动了它会改变行为。
  if (start >= size) return "unsatisfiable";
  // 末端缺省=到文件尾；超出文件尾的末端按规范夹到最后一个字节，不算错。
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  return { start, end };
}
