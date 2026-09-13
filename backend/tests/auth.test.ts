import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";
import type WebSocket from "ws";
import { AUTH_COOKIE_NAME, createAuthentication, type AuthOptions } from "../src/auth.ts";

const PASSWORD = "unit-test-password-only";
const request = (cookie?: string) => ({ headers: cookie ? { cookie } : {}, socket: { remoteAddress: "127.0.0.1" } }) as IncomingMessage;
function fakeSocket() {
  const socket = Object.assign(new EventEmitter(), {
    sent: [] as unknown[], terminated: 0,
    send(data: unknown) { this.sent.push(data); },
    terminate() { this.terminated++; this.emit("close"); },
  });
  return { socket, ws: socket as unknown as WebSocket };
}
async function fixture(options?: false | AuthOptions) {
  const auth = createAuthentication(options);
  const server = createServer(async (req, res) => {
    if (await auth.handle(req, res, new URL(req.url!, "http://localhost"))) return;
    if (!auth.require(req, res)) return;
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = (password = PASSWORD, cookie?: string) => fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ password }) });
  const close = async () => { auth.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { auth, base, login, close };
}
function responseCookie(response: Response): string { return response.headers.get("set-cookie")!.split(";")[0]!; }

test("missing authentication configuration fails closed while exposing only public auth state", async t => {
  const f = await fixture(); t.after(f.close);
  const state = await fetch(`${f.base}/api/auth/session`);
  assert.equal(state.headers.get("cache-control"), "no-store");
  assert.deepEqual(await state.json(), { configured: false, authenticated: false, expiresAt: null, secureCookie: true, canChangePassword: false });
  const protectedResponse = await fetch(`${f.base}/api/workspace`);
  assert.equal(protectedResponse.status, 503);
  assert.equal((await protectedResponse.json()).error.code, "auth_unconfigured");
  assert.equal((await f.login()).status, 503);
  assert.equal(f.auth.authorize(request()).allowed, false);
  const socket = fakeSocket(); assert.equal(f.auth.bindSocket(request(), socket.ws), false); assert.equal(socket.socket.terminated, 1);
});

test("explicit false is the only unauthenticated bypass and dispose closes its sockets", async t => {
  const f = await fixture(false); t.after(f.close);
  assert.equal((await fetch(`${f.base}/api/workspace`)).status, 200);
  assert.equal((await (await fetch(`${f.base}/api/auth/session`)).json()).authenticated, true);
  const socket = fakeSocket(); assert.equal(f.auth.bindSocket(request(), socket.ws), true);
  f.auth.dispose(); assert.equal(socket.socket.terminated, 1);
  assert.equal(f.auth.isAuthorized(request()), false);
});

test("configuration validates password characters, maximum UTF-8 bytes and bounded session TTL", () => {
  assert.throws(() => createAuthentication({ password: "short" }), /at least 6/);
  assert.throws(() => createAuthentication({ password: "密".repeat(5) }), /at least 6/);
  assert.throws(() => createAuthentication({ password: PASSWORD, ttlMs: 0 }), /ttlMs/);
  assert.throws(() => createAuthentication({ password: PASSWORD, ttlMs: Infinity }), /ttlMs/);
  const auth = createAuthentication({ password: "密".repeat(6) }); auth.dispose();
});

test("correct credentials create an opaque secure cookie; credentials and tokens never appear in JSON", async t => {
  const f = await fixture({ password: PASSWORD }); t.after(f.close);
  const bad = await f.login("incorrect-password"); assert.equal(bad.status, 401);
  const good = await f.login(); assert.equal(good.status, 200);
  const cookie = good.headers.get("set-cookie")!;
  assert.match(cookie, new RegExp(`^${AUTH_COOKIE_NAME}=[A-Za-z0-9_-]{43};`));
  assert.match(cookie, /; HttpOnly;/); assert.match(cookie, /; SameSite=Strict;/); assert.match(cookie, /; Secure;/); assert.match(cookie, /; Path=\//);
  const body = await good.json();
  assert.equal(body.authenticated, true); assert.equal(body.secureCookie, true);
  assert.ok(body.expiresAt > Date.now()); assert.ok(body.expiresAt <= Date.now() + 12 * 60 * 60 * 1000);
  assert.equal(JSON.stringify(body).includes(PASSWORD), false); assert.equal("token" in body, false);
  assert.equal((await fetch(`${f.base}/api/workspace`, { headers: { cookie: responseCookie(good) } })).status, 200);
  assert.equal((await fetch(`${f.base}/api/workspace`)).status, 401);
  assert.equal(f.auth.isAuthorized(request(`${responseCookie(good)}; ${responseCookie(good)}`)), false);
});

test("login rotates the prior cookie and logout fences both inbound and outbound WebSocket traffic", async t => {
  const f = await fixture({ password: PASSWORD, secureCookie: false }); t.after(f.close);
  const initial = await f.login(); const initialCookie = responseCookie(initial);
  assert.doesNotMatch(initial.headers.get("set-cookie")!, /; Secure/);
  const previous = fakeSocket(); f.auth.bindSocket(request(initialCookie), previous.ws);
  const rotated = await f.login(PASSWORD, initialCookie), rotatedCookie = responseCookie(rotated);
  assert.notEqual(rotatedCookie, initialCookie); assert.equal(f.auth.isAuthorized(request(initialCookie)), false); assert.ok(previous.socket.terminated > 0);
  const current = fakeSocket(); f.auth.bindSocket(request(rotatedCookie), current.ws);
  let first = 0, second = 0;
  current.socket.on("message", () => first++); current.socket.on("message", () => second++);
  current.socket.emit("message", "before"); current.ws.send("before");
  assert.equal(first, 1); assert.equal(second, 1); assert.deepEqual(current.socket.sent, ["before"]);
  const logout = await fetch(`${f.base}/api/auth/logout`, { method: "POST", headers: { cookie: rotatedCookie } });
  assert.equal(logout.status, 200); assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/); assert.equal((await logout.json()).authenticated, false);
  // Even explicitly dispatched messages queued before termination cannot reach listeners.
  assert.equal(current.socket.emit("message", "after"), false); current.ws.send("after");
  assert.equal(first, 1); assert.equal(second, 1); assert.deepEqual(current.socket.sent, ["before"]); assert.ok(current.socket.terminated > 0);
  assert.equal((await fetch(`${f.base}/api/workspace`, { headers: { cookie: rotatedCookie } })).status, 401);
});

test("session expiry terminates sockets without waiting for further requests", async t => {
  const f = await fixture({ password: PASSWORD, secureCookie: false, ttlMs: 80 }); t.after(f.close);
  const cookie = responseCookie(await f.login());
  const socket = fakeSocket(); assert.equal(f.auth.bindSocket(request(cookie), socket.ws), true);
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.ok(socket.socket.terminated > 0); assert.equal(f.auth.isAuthorized(request(cookie)), false);
});

test("gateway replacement cannot authorize a previous process cookie", async t => {
  const first = await fixture({ password: PASSWORD, secureCookie: false }); t.after(first.close);
  const cookie = responseCookie(await first.login());
  const replacement = createAuthentication({ password: PASSWORD, secureCookie: false }); t.after(() => replacement.dispose());
  assert.equal(first.auth.isAuthorized(request(cookie)), true); assert.equal(replacement.isAuthorized(request(cookie)), false);
});

test("login rejects malformed/oversized bodies and auth methods do not bypass protection", async t => {
  const f = await fixture({ password: PASSWORD }); t.after(f.close);
  const malformed = await fetch(`${f.base}/api/auth/login`, { method: "POST", body: "{" }); assert.equal(malformed.status, 400);
  const oversized = await fetch(`${f.base}/api/auth/login`, { method: "POST", body: "x".repeat(16 * 1024 + 1) }); assert.equal(oversized.status, 413);
  const wrongType = await fetch(`${f.base}/api/auth/login`, { method: "POST", body: JSON.stringify({ password: 1 }) }); assert.equal(wrongType.status, 400);
  const method = await fetch(`${f.base}/api/auth/login`); assert.equal(method.status, 405); assert.equal(method.headers.get("allow"), "POST");
  assert.equal((await fetch(`${f.base}/api/auth/session`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${f.base}/api/auth/unknown`)).status, 401);
});

test("login address quota cannot be bypassed by changing X-Forwarded-For", async t => {
  const f = await fixture({ password: PASSWORD }); t.after(f.close);
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`${f.base}/api/auth/login`, { method: "POST", headers: { "x-forwarded-for": `192.0.2.${i + 1}` }, body: JSON.stringify({ password: "wrong" }) });
    assert.equal(response.status, 401);
  }
  const blocked = await f.login(); assert.equal(blocked.status, 429); assert.equal(blocked.headers.get("retry-after"), "900");
});

test("incomplete login bodies cannot create an unbounded concurrent verification queue", async t => {
  const auth = createAuthentication({ password: PASSWORD }); t.after(() => auth.dispose());
  function exchange() {
    const req = Object.assign(new PassThrough(), { method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" } });
    const res = { status: 0, body: "", setHeader() {}, writeHead(code: number) { this.status = code; }, end(body: string) { this.body = body; } };
    const done = auth.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL("http://localhost/api/auth/login"));
    return { req, res, done };
  }
  // All four calls synchronously reserve a slot before awaiting body completion.
  const pending = Array.from({ length: 4 }, exchange), excess = exchange();
  await excess.done; assert.equal(excess.res.status, 429);
  excess.req.end();
  for (const entry of pending) entry.req.end(JSON.stringify({ password: "wrong" }));
  await Promise.all(pending.map(entry => entry.done));
  for (const entry of pending) assert.equal(entry.res.status, 401);
  const next = exchange(); next.req.end(JSON.stringify({ password: PASSWORD }));
  await next.done; assert.equal(next.res.status, 200);
});

test("dispose preserves an existing restart close handshake but bounds how long it can remain open", async () => {
  const auth = createAuthentication(false);
  const pendingClose = Object.assign(new EventEmitter(), {
    readyState: 2, terminated: 0, closeCalls: 0,
    send() {}, close() { this.closeCalls++; },
    terminate() { this.terminated++; this.readyState = 3; this.emit("close"); },
  });
  auth.bindSocket(request(), pendingClose as unknown as WebSocket);
  auth.dispose();
  assert.equal(auth.isAuthorized(request()), false);
  assert.equal(pendingClose.terminated, 0); assert.equal(pendingClose.closeCalls, 0);
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(pendingClose.terminated, 1);
});

test("dispose initiates a restart close on open sockets and cancels the fallback once closed", async () => {
  const auth = createAuthentication(false);
  const open = Object.assign(new EventEmitter(), {
    readyState: 1, terminated: 0, closeCode: 0,
    send() {}, close(code: number) { this.closeCode = code; this.readyState = 3; this.emit("close"); },
    terminate() { this.terminated++; },
  });
  auth.bindSocket(request(), open as unknown as WebSocket);
  auth.dispose(); assert.equal(open.closeCode, 1012); assert.equal(open.terminated, 0);
  await new Promise(resolve => setTimeout(resolve, 280)); assert.equal(open.terminated, 0);
});

test('password changes require the current password, preserve this browser, and revoke other sessions and sockets', async t => {
  const stored: string[] = [], next = '123456';
  const f = await fixture({ password: PASSWORD, secureCookie: false, savePassword: async value => { stored.push(value); } }); t.after(f.close);
  const own = responseCookie(await f.login()), other = responseCookie(await f.login());
  const ownSocket = fakeSocket(), otherSocket = fakeSocket();
  f.auth.bindSocket(request(own), ownSocket.ws); f.auth.bindSocket(request(other), otherSocket.ws);
  const change = (currentPassword: string, newPassword: unknown = next, cookie = own) => fetch(f.base + '/api/auth/password', { method: 'POST', headers: { cookie }, body: JSON.stringify({ currentPassword, newPassword }) });
  assert.equal((await (await fetch(f.base + '/api/auth/session', { headers: { cookie: own } })).json()).canChangePassword, true);
  const wrong = await change('incorrect'); assert.equal(wrong.status, 400); assert.equal((await wrong.json()).error.code, 'invalid_current_password');
  assert.equal(f.auth.isAuthorized(request(own)), true); assert.equal(f.auth.isAuthorized(request(other)), true);
  const short = await change(PASSWORD, 'short'); assert.equal(short.status, 400);
  const same = await change(PASSWORD, PASSWORD); assert.equal((await same.json()).error.code, 'password_unchanged');
  assert.deepEqual(stored, []);
  const result = await change(PASSWORD); assert.equal(result.status, 200); assert.equal(result.headers.get('set-cookie'), null);
  const body = await result.json(); assert.equal(body.authenticated, true); assert.equal(JSON.stringify(body).includes(next), false);
  assert.deepEqual(stored, [next]); assert.equal(ownSocket.socket.terminated, 0); assert.ok(otherSocket.socket.terminated > 0);
  assert.equal(f.auth.isAuthorized(request(other)), false); assert.equal(f.auth.isAuthorized(request(own)), true);
  assert.equal((await f.login(PASSWORD)).status, 401); assert.equal((await f.login(next)).status, 200);
  const replacement = await fixture({ password: stored[0]!, secureCookie: false }); t.after(replacement.close);
  assert.equal((await replacement.login(next)).status, 200, 'six-character credentials remain valid in a new authentication instance');
  assert.equal((await change(next, 'a second replacement password', other)).status, 401);
});

test('a failed password write retains the old password and every existing session', async t => {
  const f = await fixture({ password: PASSWORD, savePassword: async () => { throw new Error('private failure details'); } }); t.after(f.close);
  const own = responseCookie(await f.login()), other = responseCookie(await f.login());
  const result = await fetch(f.base + '/api/auth/password', { method: 'POST', headers: { cookie: own }, body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'new password not persisted' }) });
  assert.equal(result.status, 500); const body = await result.text(); assert.ok(body.includes('password_change_failed')); assert.ok(!body.includes('private failure details'));
  assert.equal(f.auth.isAuthorized(request(own)), true); assert.equal(f.auth.isAuthorized(request(other)), true);
  assert.equal((await f.login('new password not persisted')).status, 401); assert.equal((await f.login()).status, 200);
});

test('password mutation is serialized and logins finishing after rotation cannot use the old credential', async t => {
  let persistStarted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { persistStarted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const f = await fixture({ password: PASSWORD, savePassword: async () => { writes++; persistStarted(); await gate; } }); t.after(f.close); t.after(() => release());
  const own = responseCookie(await f.login()), next = 'serialized replacement password';
  const change = () => fetch(f.base + '/api/auth/password', { method: 'POST', headers: { cookie: own }, body: JSON.stringify({ currentPassword: PASSWORD, newPassword: next }) });
  const first = change(); await started;
  const second = await change(); assert.equal(second.status, 409); assert.equal((await second.json()).error.code, 'password_change_in_progress');
  // Reserve an old-password login before publication, but finish its body after
  // publication. It must not mint a fresh session with the previous credential.
  const req = Object.assign(new PassThrough(), { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  const res = { status: 0, setHeader() {}, writeHead(code: number) { this.status = code; }, end() {} };
  const pending = f.auth.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL('http://localhost/api/auth/login'));
  release(); assert.equal((await first).status, 200);
  req.end(JSON.stringify({ password: PASSWORD })); await pending; assert.equal(res.status, 401);
  assert.equal(writes, 1); assert.equal((await f.login(next)).status, 200);
});

test('password route fails closed without a session or a persistence provider and shares the login rate limit', async t => {
  for (const options of [false, { password: PASSWORD }] as const) {
    const f = await fixture(options); t.after(f.close);
    const cookie = options === false ? '' : responseCookie(await f.login());
    const result = await fetch(f.base + '/api/auth/password', { method: 'POST', headers: cookie ? { cookie } : {} });
    assert.equal(result.status, 409); assert.equal((await result.json()).error.code, 'password_change_unavailable');
  }
  const f = await fixture({ password: PASSWORD, savePassword: async () => { throw new Error('must not write'); } }); t.after(f.close);
  const anonymous = await fetch(f.base + '/api/auth/password', { method: 'POST' }); assert.equal(anonymous.status, 401);
  const cookie = responseCookie(await f.login());
  assert.equal((await fetch(f.base + '/api/auth/password', { headers: { cookie } })).status, 405);
  for (let i = 0; i < 9; i++) {
    const response = await fetch(f.base + '/api/auth/password', { method: 'POST', headers: { cookie, 'x-forwarded-for': `192.0.2.${i}` }, body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'another replacement password' }) });
    assert.equal(response.status, 400);
  }
  const blocked = await f.login(); assert.equal(blocked.status, 429);
  assert.equal(f.auth.isAuthorized(request(cookie)), true);
});
