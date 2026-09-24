import { apiErrorFrom } from "./errors";
import { t } from "@roost/i18n";
import { fetchWithSession } from "./session-fetch";

/* 会话信号和兜底截止时间住在 `session-fetch.ts`（零 import 的叶子模块，理由见那里）。
   这里转发出去，免得已有的调用点全部改路径。 */
export { acceptAuthenticatedSession, onSessionExpired, fetchWithSession } from "./session-fetch";

export async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithSession(input, init);
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(timedOut ? t.misc.request.timeout : t.misc.request.offline);
  }
  if (!res.ok) throw await apiErrorFrom(res);
  return res.json() as Promise<T>;
}
