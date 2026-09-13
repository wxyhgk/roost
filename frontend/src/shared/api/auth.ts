import { acceptAuthenticatedSession, request } from "./request";

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
export function fetchAuthSession(signal?: AbortSignal) {
  return request<AuthSession>("/api/auth/session", { signal, cache: "no-store" });
}

export async function login(password: string) {
  const session = await request<AuthSession>("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
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
