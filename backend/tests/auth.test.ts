import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";
import type WebSocket from "ws";
import { AUTH_COOKIE_NAME, createAuthentication, type AuthOptions } from "../src/auth.ts";
import { solveChallenge, MIN_ITERATIONS } from '@roost/auth-challenge';

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
  /*
    **关掉空闲连接的超时，否则 Linux 上这些用例会随机以 ECONNRESET 失败。**

    测试和被测的服务端在**同一个进程**里，而 `solveChallenge` 是同步的 20 万次 PBKDF2：
    它一跑就把事件循环钉死好几秒。Node 默认 5 秒关掉空闲的 keep-alive 连接，于是那个
    定时器常常正好落在两次请求之间的这段空档里。

    连接关在客户端刚发出下一个请求的那一刻时，**Linux 回的是 RST**（macOS 回 FIN，
    undici 能干净地重开一条，所以本机怎么加负载都复现不出来——实测把 CPU 占满、这条
    用例跑到 21.8 秒，照样通过）。客户端看到的就是 `fetch failed / ECONNRESET`，
    而且落在哪个请求上全看定时器落点，看起来像随机失败。

    平时轮不到服务端关：实测 undici 自己在 3.0 秒（服务端广告 timeout=5 时）或 4.0 秒
    （没广告时）就把空闲连接收了，客户端自己关的连接没有竞态。**只有事件循环被堵过
    5 秒、两个定时器一起积压时，服务端那个才可能抢先**——正好是这条用例在慢机器上的样子。

    这是 HTTP/1.1 keep-alive 的固有竞态，不是认证逻辑的毛病——真实浏览器对幂等请求
    会自己重试。用例要的是确定性，所以这里干脆不给服务端这个定时器（设成 0 就不再广告
    Keep-Alive，也不再按空闲关连接）；`close()` 里的 `closeAllConnections()` 负责收尾。
  */
  server.keepAliveTimeout = 0;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = (password = PASSWORD, cookie?: string) => fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ password }) });
  const close = async () => { auth.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { auth, base, login, close };
}
function responseCookie(response: Response): string { return response.headers.get("set-cookie")!.split(";")[0]!; }

test('desktop sessions need the native token, have no password flow, and are invalidated with the HTTP process', async t => {
  const token = 'a'.repeat(43), cookie = `${AUTH_COOKIE_NAME}=${token}`;
  const f = await fixture({ desktopSession: token, secureCookie: false }); t.after(f.close);
  assert.equal((await fetch(f.base + '/api/workspace')).status, 401);
  assert.equal((await fetch(f.base + '/api/workspace', { headers: { cookie } })).status, 200);
  const state = await (await fetch(f.base + '/api/auth/session', { headers: { cookie } })).json();
  assert.equal(state.authenticated, true); assert.equal(state.canChangePassword, false); assert.equal(state.expiresAt, null);
  for (const route of ['login', 'logout', 'password']) {
    const response = await fetch(f.base + '/api/auth/' + route, { method: 'POST', headers: { cookie }, body: '{}' });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'desktop_session_managed');
  }
  const invalid = fakeSocket(); assert.equal(f.auth.bindSocket(request(), invalid.ws), false);
  const valid = fakeSocket(); assert.equal(f.auth.bindSocket(request(cookie), valid.ws), true);
  f.auth.dispose(); assert.equal(f.auth.isAuthorized(request(cookie)), false); assert.equal(valid.socket.terminated, 1);
  const replacement = createAuthentication({ desktopSession: 'b'.repeat(43), secureCookie: false }); t.after(replacement.dispose);
  assert.equal(replacement.isAuthorized(request(cookie)), false);
  assert.throws(() => createAuthentication({ desktopSession: 'short', secureCookie: false }), /desktop session/);
});

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

/*
  挑战-响应登录：明文 HTTP 上，密码不该出现在线上。

  这条链路的每一步都单独钉，因为它的失效方式都是**安静的**——密码照样能登进去，
  只是保护没了，界面上看不出任何区别。
*/
async function solve(base: string, password = PASSWORD) {
  const challenge = await (await fetch(`${base}/api/auth/challenge`)).json();
  return { challenge, proof: solveChallenge(password, challenge) };
}
const postLogin = (base: string, body: unknown) =>
  fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test('挑战-响应能登进去，而且请求体里不含密码', async t => {
  const f = await fixture({ password: PASSWORD, secureCookie: false }); t.after(f.close);
  const { challenge, proof } = await solve(f.base);
  assert.ok(challenge.iterations >= MIN_ITERATIONS, '迭代次数不能低于客户端愿意接受的下限');
  const payload = JSON.stringify({ nonce: challenge.nonce, proof });
  assert.ok(!payload.includes(PASSWORD), '整条协议的意义就在这一行：线上没有密码');

  const response = await postLogin(f.base, { nonce: challenge.nonce, proof });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authenticated, true);
  const cookie = responseCookie(response);
  assert.equal((await fetch(f.base + '/api/workspace', { headers: { cookie } })).status, 200);
});

/* 随机数一次性是这条协议的全部意义：留着让人重试，它就退化成一个静态口令。 */
test('同一个应答不能用第二次', async t => {
  const f = await fixture({ password: PASSWORD, secureCookie: false }); t.after(f.close);
  const { challenge, proof } = await solve(f.base);
  assert.equal((await postLogin(f.base, { nonce: challenge.nonce, proof })).status, 200);
  assert.equal((await postLogin(f.base, { nonce: challenge.nonce, proof })).status, 401, '重放必须失败');
});

test('答错了那个挑战也当场作废，不能拿着同一个随机数慢慢试', async t => {
  const f = await fixture({ password: PASSWORD, secureCookie: false }); t.after(f.close);
  const { challenge } = await solve(f.base);
  const wrong = solveChallenge('not the password', challenge);
  assert.equal((await postLogin(f.base, { nonce: challenge.nonce, proof: wrong })).status, 401);
  // 挑战已经用掉了：哪怕现在算对了也进不去，必须重新领一个。
  const right = solveChallenge(PASSWORD, challenge);
  assert.equal((await postLogin(f.base, { nonce: challenge.nonce, proof: right })).status, 401);
  const fresh = await solve(f.base);
  assert.equal((await postLogin(f.base, { nonce: fresh.challenge.nonce, proof: fresh.proof })).status, 200);
});

test('别人的随机数、瞎编的随机数都不认', async t => {
  const f = await fixture({ password: PASSWORD, secureCookie: false }); t.after(f.close);
  const { challenge, proof } = await solve(f.base);
  assert.equal((await postLogin(f.base, { nonce: 'made-up-nonce', proof })).status, 401);
  assert.equal((await postLogin(f.base, { nonce: challenge.nonce, proof: 'x' })).status, 401);
  assert.equal((await postLogin(f.base, { nonce: 42, proof })).status, 401, '类型不对不该崩，只该拒绝');
});

/*
  明文那条路留着，是为了不被锁在门外（缓存里一份旧前端、或者一个 curl）。
  它挡不住主动的中间人——但纯 HTTP 上那种人可以直接往页面里注 JS，换协议也拦不住。
*/
test('明文密码那条路还在，两条路都通', async t => {
  const f = await fixture({ password: PASSWORD, secureCookie: false }); t.after(f.close);
  assert.equal((await f.login()).status, 200);
  const { challenge, proof } = await solve(f.base);
  assert.equal((await postLogin(f.base, { nonce: challenge.nonce, proof })).status, 200);
});

test('改密之后，旧密码派生的应答立刻失效', async t => {
  const f = await fixture({ password: PASSWORD, secureCookie: false, savePassword: async () => {} }); t.after(f.close);
  const cookie = responseCookie(await f.login());
  // 先领一个挑战再改密：这一份必须跟着作废，否则改密之后旧密码还能进来一次。
  const stale = await solve(f.base);
  const changed = await fetch(f.base + '/api/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'brand-new-password' }),
  });
  assert.equal(changed.status, 200);
  assert.equal((await postLogin(f.base, { nonce: stale.challenge.nonce, proof: stale.proof })).status, 401);
  const next = await solve(f.base, 'brand-new-password');
  assert.equal((await postLogin(f.base, { nonce: next.challenge.nonce, proof: next.proof })).status, 200, '新密码要能登进去');
});

test('没配认证 / 桌面会话时不发挑战，方法也限死 GET', async t => {
  const f = await fixture({ desktopSession: 'a'.repeat(43), secureCookie: false }); t.after(f.close);
  assert.equal((await fetch(f.base + '/api/auth/challenge')).status, 409);
  const g = await fixture({ password: PASSWORD, secureCookie: false }); t.after(g.close);
  const wrongMethod = await fetch(g.base + '/api/auth/challenge', { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
});
