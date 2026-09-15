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
