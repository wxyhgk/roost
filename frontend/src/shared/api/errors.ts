import { errorText } from "@roost/i18n";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    /** 后端原文，可能已经作为 message 使用，也可能只留作诊断。 */
    readonly serverMessage: string | null,
    /** 完整响应体：409 冲突会在这里带上当前文件内容与 mtime。 */
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 读一次响应体并解析成 ApiError。响应体只能读一次，调用方不要再读。 */
export async function apiErrorFrom(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // 未 code 化的端点仍可能返回纯文本。
  }
  const err = (body?.error ?? null) as { code?: unknown; message?: unknown } | null;
  const code = typeof err?.code === "string" ? err.code : null;
  // 纯文本兜底：只接受看起来像一句话的内容，避免把代理返回的 HTML 错误页糊到界面上。
  const plain = !body && text && text.length <= 200 && !text.includes("<") ? text : null;
  // 附件等尚未 code 化的端点返回扁平 {message}。
  const flat = typeof body?.message === "string" ? body.message : null;
  const serverMessage = typeof err?.message === "string" ? err.message : flat ?? plain;
  return new ApiError(response.status, code, errorText(code, response.status, serverMessage), serverMessage, body);
}
