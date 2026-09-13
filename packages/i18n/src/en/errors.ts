// 后端错误码 → 展示文案。后端统一返回 {error:{code,message}}
// （backend/src/http.ts 的 sendError / ApiErrorCode）。
// code 是 API 契约：新增只需在下表补一行，漏了会退回后端原文或状态码文案；改名会破坏这张表。
//
// 放在包里而不是 frontend/src/api 下，是为了让 library/ 也能用同一套——它受边界规则
// 限制只能相对引用 library/ 内部，但包引用不受该规则约束。

const BY_CODE: Record<string, string> = {
  too_large: "content too large",
  internal_error: "internal server error",
  storage_unavailable: "storage unavailable",
  not_found: "not found",
  conflict: "conflict",
  method_not_allowed: "method not allowed",
  unsupported_media_type: "unsupported media type",
  request_timeout: "request timed out",
  file_conflict: "file changed by another program",
  binary_file: "binary file cannot be handled as text",
  not_file: "target is not an editable file",
  path_escape: "path escapes the workspace",
  upload_busy: "Too many uploads at once. Please retry shortly.",
  permission_denied: "permission denied",
};

// 这些 code 的 message 本身就是载荷——是哪个字段、超了什么范围，只有后端知道。
// 覆盖成通用文案等于把用户真正需要的信息删掉，所以宁可显示英文原文。
const MESSAGE_CARRYING = new Set(["invalid_request"]);

// 尚未 code 化的端点（server.ts 里若干 text(res, 4xx, "...")）只能落到这里。
const BY_STATUS: Record<number, string> = {
  400: "invalid request",
  403: "permission denied",
  404: "not found",
  409: "conflict",
  413: "content too large",
  415: "unsupported media type",
  429: "too many requests, try again later",
  503: "service temporarily unavailable",
};

export function errorText(code: string | null, status: number, serverMessage?: string | null): string {
  if (code && MESSAGE_CARRYING.has(code) && serverMessage) return serverMessage;
  if (code && BY_CODE[code]) return BY_CODE[code];
  return serverMessage || BY_STATUS[status] || `Request failed (${status})`;
}
