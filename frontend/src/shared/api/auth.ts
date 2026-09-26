import { acceptAuthenticatedSession, request } from "./request";
import { solveChallenge, type LoginChallenge } from "@roost/auth-challenge";

/**
 * 登录。
 *
 * 身份完全由 HttpOnly Cookie 承载——**前端读不到它，也不该试图管理它**。
 * 所以这里没有任何 token 存储：不写 localStorage，不解析 Cookie，
 * 每次只问服务端「我现在算不算登录了」。
 */
export type AuthSession = {
  /** 后端有没有配置认证。false 表示服务端配置问题，不是你没登录。 */
  configured: boolean;
  authenticated: boolean;
  /** Unix 毫秒。 */
  expiresAt: number | null;
  /** Cookie 是否带 Secure。明文 HTTP 下必须为 false，否则浏览器根本不会保存。 */
  secureCookie: boolean;
  canChangePassword?: boolean;
};

/**
 * 唯一的**公开**接口。探测后端是否活着必须用它——
 * `/api/health` 现在也要登录，把它的 401 当成「后端离线」会得出完全错误的结论。
 */
export async function fetchAuthSession(signal?: AbortSignal) {
  const session = await request<AuthSession>("/api/auth/session", { signal, cache: "no-store" });
  /*
    **查出来「本来就登录着」也要开闸。**

    `fetchWithSession` 在收到普通请求的 401 之后会停发后续请求（见那里的注释）。开闸原本只
    挂在 login/changePassword 上，于是有一条走不出去的路：闸因为一发 401 关上（后端重启、
    网络抖一下都可能），而 cookie 其实一直有效——这一次 `/api/auth/session` 回 200 说你登录
    着，界面也确实解锁了，**但闸还关着**，所有轮询继续被短路，页面从此不更新。

    服务器刚说了这个 cookie 能用，这和登录成功是同一件事，判据也该是同一个。
  */
  if (session.authenticated) acceptAuthenticatedSession();
  return session;
}

/*
  登录**不发密码**。

  先问服务端要一个一次性随机数，本地用密码派生出密钥，发上去的是
  `HMAC(密钥, 随机数)`。这样明文 HTTP 上抓包的人拿不到密码本身。
  完整的取舍（它解决什么、不解决什么）写在 `@roost/auth-challenge` 顶上。

  派生要跑二十万次 PBKDF2，在手机上可能一两秒——所以 `onProgress` 让界面能说一句
  「正在校验」，不然那段时间看起来就像点了没反应。
*/
export async function login(password: string, onProgress?: () => void) {
  const challenge = await request<LoginChallenge>("/api/auth/challenge", { cache: "no-store" });
  onProgress?.();
  // 让出一帧再开始算：PBKDF2 是同步的，会把主线程占住，不先渲染一次就看不到那句提示。
  await new Promise(resolve => setTimeout(resolve, 0));
  const proof = solveChallenge(password, challenge);
  const session = await request<AuthSession>("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: challenge.nonce, proof }),
  });
  if (session.authenticated) acceptAuthenticatedSession();
  return session;
}

export function logout() {
  return request<AuthSession>("/api/auth/logout", { method: "POST" });
}

export async function changePassword(currentPassword: string, newPassword: string, signal: AbortSignal) {
  const session = await request<AuthSession>("/api/auth/password", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }), signal,
  });
  if (session.authenticated) acceptAuthenticatedSession();
  return session;
}
