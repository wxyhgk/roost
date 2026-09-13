import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type WebSocket from "ws";

export type AuthOptions = { password: string; secureCookie?: boolean; ttlMs?: number; savePassword?: (password: string) => Promise<void> };
export type AuthenticationDecision =
  | { allowed: true; token: string | null }
  | { allowed: false; status: 401 | 503; code: "authentication_required" | "auth_unconfigured"; message: string };
export const AUTH_COOKIE_NAME = "roost_session";
const MAX_BODY = 16 * 1024;
const MAX_SESSIONS = 1000;
const RATE_WINDOW = 15 * 60 * 1000;
const MAX_ADDRESSES = 1000;
type AuthSession = { expiresAt: number; timer: ReturnType<typeof setTimeout>; sockets: Set<WebSocket> };
type AttemptWindow = { startedAt: number; count: number };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function fail(res: ServerResponse, status: number, code: string, message: string) {
  json(res, status, { error: { code, message } });
}
function cookieToken(req: IncomingMessage): string | null {
  const values = (req.headers.cookie ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0]!.slice(AUTH_COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

class LoginInputError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function loginBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let finished = false;
    const timer = setTimeout(() => finish(new LoginInputError(408, "request_timeout", "login request timed out")), 5000);
    timer.unref();
    function finish(error?: Error) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("error", errorHandler); req.off("aborted", aborted);
      if (error) { chunks.length = 0; req.resume(); reject(error); return; }
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolve(value as Record<string, unknown>);
      } catch { reject(new LoginInputError(400, "invalid_request", "JSON object required")); }
    }
    function data(chunk: Buffer) {
      bytes += chunk.length;
      if (bytes > MAX_BODY) finish(new LoginInputError(413, "too_large", "login request body too large"));
      else chunks.push(chunk);
    }
    function end() { finish(); }
    function errorHandler() { finish(new LoginInputError(400, "invalid_request", "login request interrupted")); }
    function aborted() { errorHandler(); }
    req.on("data", data); req.on("end", end); req.on("error", errorHandler); req.on("aborted", aborted);
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY) finish(new LoginInputError(413, "too_large", "login request body too large"));
  });
}

/** Process-local opaque sessions: restarting HTTP requires logging in again.
 * Origin validation is deliberately owned by the common HTTP/upgrade ingress.
 */
export function createAuthentication(options?: false | AuthOptions) {
  const disabled = options === false;
  const configured = options !== undefined;
  const secureCookie = options ? options.secureCookie ?? true : !disabled;
  const ttlMs = options ? options.ttlMs ?? 12 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  if (options && (typeof options.password !== "string" || Array.from(options.password).length < 6 || Buffer.byteLength(options.password) > 4096)) throw new Error("authentication password must contain at least 6 characters and at most 4096 UTF-8 bytes");
  if (options && options.secureCookie !== undefined && typeof options.secureCookie !== "boolean") throw new Error("secureCookie must be a boolean");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 2_147_483_647) throw new Error("authentication ttlMs must be between 1 and 2147483647");
  const salt = randomBytes(32);
  let passwordHash: Buffer | null = options ? scryptSync(options.password, salt, 64) : null;
  let passwordRevision = 0;
  let changingPassword = false;
  const sessions = new Map<string, AuthSession>();
  const sockets = new Set<WebSocket>();
  const bound = new WeakSet<WebSocket>();
  const attempts = new Map<string, AttemptWindow>();
  let globalAttempts: AttemptWindow = { startedAt: Date.now(), count: 0 };
  let pendingLogins = 0;
  let disposed = false;

  function revoke(token: string) {
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token); clearTimeout(session.timer);
    for (const ws of session.sockets) ws.terminate();
    session.sockets.clear();
  }
  function active(token: string | null): boolean {
    if (disposed) return false;
    if (disabled) return true;
    if (!token) return false;
    const session = sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) { revoke(token); return false; }
    return true;
  }
  function authorize(req: IncomingMessage): AuthenticationDecision {
    if (!configured || disposed) return { allowed: false, status: 503, code: "auth_unconfigured", message: "authentication is unavailable" };
    const token = cookieToken(req);
    if (!active(token)) return { allowed: false, status: 401, code: "authentication_required", message: "login required" };
    return { allowed: true, token: disabled ? null : token };
  }
  function state(req: IncomingMessage) {
    const decision = authorize(req);
    return { configured: configured && !disposed, authenticated: decision.allowed,
      expiresAt: decision.allowed && decision.token ? sessions.get(decision.token)!.expiresAt : null, secureCookie,
      canChangePassword: decision.allowed && !!options && typeof options.savePassword === "function" };
  }
  function cookie(token: string, expiresAt: number | null) {
    return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict${secureCookie ? "; Secure" : ""}; Max-Age=${expiresAt === null ? 0 : Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))}; Expires=${new Date(expiresAt ?? 0).toUTCString()}`;
  }
  function allowAttempt(req: IncomingMessage) {
    const now = Date.now();
    for (const [address, window] of attempts) if (now - window.startedAt >= RATE_WINDOW) attempts.delete(address);
    if (now - globalAttempts.startedAt >= RATE_WINDOW) globalAttempts = { startedAt: now, count: 0 };
    // Proxy-supplied forwarding headers are untrusted. A configured reverse proxy
    // therefore shares an address quota unless a separate trusted-proxy layer exists.
    const address = req.socket.remoteAddress ?? "unknown";
    let window = attempts.get(address);
    if (pendingLogins >= 4 || globalAttempts.count >= 100 || (window?.count ?? 0) >= 10 || (!window && attempts.size >= MAX_ADDRESSES)) return false;
    if (!window) { window = { startedAt: now, count: 0 }; attempts.set(address, window); }
    window.count++; globalAttempts.count++;
    return true;
  }
  const hashPassword = (password: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, (error, value) => error ? reject(error) : resolve(value)));
  async function changePassword(req: IncomingMessage, res: ServerResponse) {
    const decision = authorize(req);
    if (!decision.allowed) { fail(res, decision.status, decision.code, decision.message); req.resume(); return; }
    if (!options || !options.savePassword) { fail(res, 409, "password_change_unavailable", "password changes are unavailable"); req.resume(); return; }
    if (changingPassword) { fail(res, 409, "password_change_in_progress", "a password change is already in progress"); req.resume(); return; }
    if (!allowAttempt(req)) { res.setHeader("retry-after", "900"); fail(res, 429, "rate_limited", "too many password attempts"); req.resume(); return; }
    changingPassword = true; pendingLogins++;
    let nextHash: Buffer | undefined;
    try {
      const body = await loginBody(req);
      if (typeof body.currentPassword !== "string" || Buffer.byteLength(body.currentPassword) > 4096)
        throw new LoginInputError(400, "invalid_request", "currentPassword must be a string of at most 4096 UTF-8 bytes");
      if (typeof body.newPassword !== "string" || Array.from(body.newPassword).length < 6 || body.newPassword.length > 1024 || /[\r\n\0]/.test(body.newPassword))
        throw new LoginInputError(400, "invalid_new_password", "new password must contain 6 to 1024 characters without line breaks or NUL");
      if (body.newPassword === body.currentPassword) throw new LoginInputError(400, "password_unchanged", "new password must differ from the current password");
      const hash = await hashPassword(body.currentPassword);
      const valid = timingSafeEqual(hash, passwordHash!); hash.fill(0);
      if (!valid) throw new LoginInputError(400, "invalid_current_password", "current password is incorrect");
      nextHash = await hashPassword(body.newPassword);
      if (!active(decision.token)) throw new LoginInputError(401, "authentication_required", "login required");
      // Publish only after durable storage succeeds. Existing sockets owned by
      // this browser keep their cookie; other sessions lose access to the PTY.
      await options.savePassword(body.newPassword);
      passwordHash?.fill(0); passwordHash = nextHash; nextHash = undefined; passwordRevision++;
      for (const token of sessions.keys()) if (token !== decision.token) revoke(token);
      if (disposed) { passwordHash?.fill(0); fail(res, 503, "auth_unconfigured", "authentication is unavailable"); return; }
      if (!active(decision.token)) { fail(res, 401, "authentication_required", "password updated; login required"); return; }
      json(res, 200, state(req));
    } catch (error) {
      if (error instanceof LoginInputError) fail(res, error.status, error.code, error.message);
      else fail(res, 500, "password_change_failed", "password could not be saved");
    } finally { nextHash?.fill(0); changingPassword = false; pendingLogins--; }
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!["/api/auth/session", "/api/auth/login", "/api/auth/logout", "/api/auth/password"].includes(path)) return false;
    const method = path === "/api/auth/session" ? "GET" : "POST";
    if (req.method !== method) { res.setHeader("allow", method); fail(res, 405, "method_not_allowed", "method not allowed"); return true; }
    if (path === "/api/auth/session") { json(res, 200, state(req)); return true; }
    if (!configured || disposed) { fail(res, 503, "auth_unconfigured", "authentication is unavailable"); return true; }
    if (path === "/api/auth/password") { await changePassword(req, res); return true; }
    if (path === "/api/auth/logout") {
      const token = cookieToken(req); if (token) revoke(token);
      res.setHeader("set-cookie", cookie("", null));
      json(res, 200, state(req)); return true;
    }
    if (disabled) { json(res, 200, state(req)); return true; }
    if (!allowAttempt(req)) { res.setHeader("retry-after", "900"); fail(res, 429, "rate_limited", "too many login attempts"); req.resume(); return true; }
    pendingLogins++;
    const revision = passwordRevision;
    try {
      const body = await loginBody(req);
      if (typeof body.password !== "string" || Buffer.byteLength(body.password) > 4096) throw new LoginInputError(400, "invalid_request", "password must be a string of at most 4096 UTF-8 bytes");
      const hash = await hashPassword(body.password);
      const valid = revision === passwordRevision && timingSafeEqual(hash, passwordHash!); hash.fill(0);
      if (disposed) { fail(res, 503, "auth_unconfigured", "authentication is unavailable"); return true; }
      if (!valid) { fail(res, 401, "authentication_required", "invalid credentials"); return true; }
      for (const [token, session] of sessions) if (session.expiresAt <= Date.now()) revoke(token);
      const old = cookieToken(req);
      if (sessions.size >= MAX_SESSIONS && (!old || !sessions.has(old))) { fail(res, 503, "auth_capacity", "too many active login sessions"); return true; }
      if (old) revoke(old);
      const token = randomBytes(32).toString("base64url"), expiresAt = Date.now() + ttlMs;
      const timer = setTimeout(() => revoke(token), ttlMs); timer.unref();
      sessions.set(token, { expiresAt, timer, sockets: new Set() });
      res.setHeader("set-cookie", cookie(token, expiresAt));
      json(res, 200, { configured: true, authenticated: true, expiresAt, secureCookie, canChangePassword: !!options && !!options.savePassword });
    } catch (error) {
      if (error instanceof LoginInputError) fail(res, error.status, error.code, error.message);
      else fail(res, 500, "internal_error", "login could not be completed");
    } finally { pendingLogins--; }
    return true;
  }
  function bindSocket(req: IncomingMessage, ws: WebSocket): boolean {
    const decision = authorize(req);
    if (!decision.allowed) { ws.terminate(); return false; }
    if (bound.has(ws)) return true;
    bound.add(ws); sockets.add(ws);
    const token = decision.token;
    if (token) sessions.get(token)!.sockets.add(ws);
    const originalEmit = ws.emit, originalSend = ws.send;
    // A normal/prepended message listener cannot stop EventEmitter's other
    // listeners. Fence dispatch itself, including messages queued before logout.
    ws.emit = function (this: WebSocket, event: string | symbol, ...args: unknown[]) {
      if (event === "message" && !active(token)) { ws.terminate(); return false; }
      return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
    } as typeof ws.emit;
    ws.send = function (this: WebSocket, ...args: unknown[]) {
      if (!active(token)) {
        ws.terminate();
        const callback = args.at(-1);
        if (typeof callback === "function") queueMicrotask(() => callback(new Error("authentication expired")));
        return;
      }
      Reflect.apply(originalSend, this, args);
    } as typeof ws.send;
    ws.once("close", () => { sockets.delete(ws); if (token) sessions.get(token)?.sockets.delete(ws); });
    return true;
  }
  return {
    handle, authorize, bindSocket,
    isAuthorized: (req: IncomingMessage) => authorize(req).allowed,
    require(req: IncomingMessage, res: ServerResponse): boolean {
      const decision = authorize(req);
      if (decision.allowed) return true;
      fail(res, decision.status, decision.code, decision.message); return false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Shutdown immediately invalidates authentication, but an existing restart
      // close frame must be allowed to reach clients. Logout/expiry still revoke
      // with immediate termination through revoke().
      for (const session of sessions.values()) { clearTimeout(session.timer); session.sockets.clear(); }
      sessions.clear();
      for (const ws of sockets) {
        if ((ws.readyState !== 1 && ws.readyState !== 2) || typeof ws.close !== "function") { ws.terminate(); continue; }
        const timer = setTimeout(() => { if (ws.readyState !== 3) ws.terminate(); }, 250);
        timer.unref(); ws.once("close", () => clearTimeout(timer));
        if (ws.readyState === 1) {
          try { ws.close(1012, "server restarting"); }
          catch { clearTimeout(timer); ws.terminate(); }
        }
      }
      sockets.clear(); attempts.clear(); passwordHash?.fill(0); salt.fill(0);
    },
  };
}
