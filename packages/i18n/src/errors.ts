// 后端错误码 → 展示文案。后端统一返回 {error:{code,message}}
// （backend/src/http.ts 的 sendError / ApiErrorCode）。
// code 是 API 契约：新增只需在下表补一行，漏了会退回后端原文或状态码文案；改名会破坏这张表。
//
// 放在包里而不是 frontend/src/api 下，是为了让 library/ 也能用同一套——它受边界规则
// 限制只能相对引用 library/ 内部，但包引用不受该规则约束。

const BY_CODE: Record<string, string> = {
  too_large: "内容超出大小限制",
  internal_error: "服务器内部错误",
  storage_unavailable: "存储暂时不可用，请稍后重试",
  not_found: "目标不存在",
  conflict: "目标已存在或状态冲突",
  method_not_allowed: "不支持的请求方法",
  unsupported_media_type: "不支持的文件类型",
  request_timeout: "请求超时",
  file_conflict: "文件已被其他程序修改",
  binary_file: "二进制文件无法以文本方式处理",
  not_file: "目标不是可操作的文件",
  path_escape: "路径超出工作目录范围",
  upload_busy: "同时上传的文件过多，请稍后重试",
  permission_denied: "没有访问权限",
};

// 这些 code 的 message 本身就是载荷——是哪个字段、超了什么范围，只有后端知道。
// 覆盖成通用文案等于把用户真正需要的信息删掉，所以宁可显示英文原文。
const MESSAGE_CARRYING = new Set(["invalid_request"]);

// 尚未 code 化的端点（server.ts 里若干 text(res, 4xx, "...")）只能落到这里。
const BY_STATUS: Record<number, string> = {
  400: "请求无效",
  403: "没有访问权限",
  404: "目标不存在",
  409: "状态冲突",
  413: "内容超出大小限制",
  415: "不支持的文件类型",
  429: "请求过于频繁，请稍后重试",
  503: "服务暂时不可用",
};

export function errorText(code: string | null, status: number, serverMessage?: string | null): string {
  if (code && MESSAGE_CARRYING.has(code) && serverMessage) return serverMessage;
  if (code && BY_CODE[code]) return BY_CODE[code];
  return serverMessage || BY_STATUS[status] || `请求失败（${status}）`;
}
