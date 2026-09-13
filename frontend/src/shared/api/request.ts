import { apiErrorFrom } from "./errors";
import { t } from "@roost/i18n";

/**
 * 登录失效的全局信号。
 *
 * 401 可能从任何一个请求上回来（后台轮询、文件监听重连、发信……）。让每个调用点
 * 各自处理必然会漏，所以在这里统一广播一次，由登录关卡订阅。
 */
const expiredListeners = new Set<() => void>();
let authGeneration = 0;
/** A newly accepted cookie supersedes requests sent with the previous cookie. */
export function acceptAuthenticatedSession() { authGeneration++; }
export function onSessionExpired(fn: () => void) {
  expiredListeners.add(fn);
  return () => { expiredListeners.delete(fn); };
}

/**
 * 所有请求的兜底截止时间。
 *
 * 没有它的时候，一个不回来的请求会把调用方永远钉在「加载中」：promise 不 settle，
 * `finally` 不跑，loading 不清，界面既不报错也没有重试入口。
 *
 * 最坏的一处是登录关卡：`fetchAuthSession` 是页面发出的**第一个**请求，也是整个应用
 * 唯一的解锁条件，而那里的重试按钮只在 error 分支渲染——它挂住就是整页死锁，
 * 用户只能刷新页面。**有限的失败远好过无限的沉默。**
 *
 * 放在这一层而不是各个调用点：调用点总有漏的，而漏掉的代价是永久卡死。
 */
export const REQUEST_TIMEOUT_MS = 45_000;

export async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const generation = authGeneration;
  /*
    调用方自己的 signal（effect 清理、切换目标）和这道截止时间是**两个**中止理由，
    必须同时生效。用 any 合并而不是让谁覆盖谁：前者被覆盖的话，切走的请求会继续占着
    连接、在慢链路上排在新请求前面；后者被覆盖的话，挂死的请求又变回无限等待。
  */
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  let res: Response;
  try {
    res = await fetch(input, { ...init, signal });
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(timedOut ? t.misc.request.timeout : t.misc.request.offline);
  }
  // 旧 Cookie 的迟到 401 仍向调用者报错，但不能撤销一次已成功的登录。
  // 注意**不要**在这里自动跳登录或重试：
  // 未提交的输入必须留在原地，由界面决定怎么提示。
  if (res.status === 401 && generation === authGeneration) for (const fn of [...expiredListeners]) fn();
  if (!res.ok) throw await apiErrorFrom(res);
  return res.json() as Promise<T>;
}
