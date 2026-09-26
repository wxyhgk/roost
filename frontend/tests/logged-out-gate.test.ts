/*
  登出之后不再发请求。

  会话过期时登录关卡只盖一层模糊 + 登录浮层、**不卸载**应用（那是对的：未提交的内容必须
  留在原地）。代价是里面所有轮询器照常跑，每一次都吃 401。实测一个开着不动的过期标签页
  **64 次/分钟全是 401**，一天约 9 万次——在 iPad 上是电量和射频，在服务端是白烧的 CPU，
  而且它不报错，所以一直没被发现。

  下面每条盯的都是一种「闸没关上」或「闸关错了」。后者尤其要紧：把闸关在不该关的地方，
  会把一个仍然登录着的人的全部轮询掐掉，那比多发点请求糟得多。
*/
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { request, acceptAuthenticatedSession, onSessionExpired } from '../src/shared/api/request.ts';
import { isLoggedOut } from '../src/shared/api/session-fetch.ts';
import { ApiError } from '../src/shared/api/errors.ts';
import { changePassword } from '../src/shared/api/auth.ts';

const unauthorized = () => Response.json({ error: { code: 'unauthorized', message: 'login required' } }, { status: 401 });
const ok = () => Response.json({ ok: true });

beforeEach(() => acceptAuthenticatedSession());

test('普通请求上的 401 关闸，之后的普通请求不再出网', async t => {
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', (path: string) => { seen.push(path); return Promise.resolve(unauthorized()); });
  await assert.rejects(request('/api/workspace'), ApiError);
  assert.equal(isLoggedOut(), true);
  const after = seen.length;
  for (const p of ['/api/workspace', '/api/conversations', '/api/server/summary']) await assert.rejects(request(p), ApiError);
  assert.equal(seen.length, after, '闸关上之后这些请求一个都不该出网');
});

test('短路返回的 401 形状和服务器给的一样——调用方的处理不用改一行', async t => {
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(unauthorized()));
  await assert.rejects(request('/api/workspace'), ApiError);
  await assert.rejects(request('/api/conversations'), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401, '短路的响应也要是 401');
    return true;
  });
});

test('/api/auth/ 必须放行，否则登录检查和登录本身一起被锁死', async t => {
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', (path: string) => {
    seen.push(path);
    return Promise.resolve(path.startsWith('/api/auth/') ? ok() : unauthorized());
  });
  await assert.rejects(request('/api/workspace'), ApiError);
  assert.equal(isLoggedOut(), true);
  await request('/api/auth/session');
  assert.ok(seen.includes('/api/auth/session'), '认证请求被闸挡住了——那就是永久死锁');
});

test('登录成功开闸', async t => {
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', (path: string) => {
    seen.push(path);
    return Promise.resolve(seen.length === 1 ? unauthorized() : ok());
  });
  await assert.rejects(request('/api/workspace'), ApiError);
  assert.equal(isLoggedOut(), true);
  acceptAuthenticatedSession();
  assert.equal(isLoggedOut(), false);
  const after = seen.length;
  await request('/api/workspace');
  assert.equal(seen.length, after + 1, '开闸之后请求要能出网');
});

test('改密码时输错当前密码**不**关闸——那个人还登录着', async t => {
  let expired = 0;
  t.after(onSessionExpired(() => { expired++; }));
  t.mock.method(globalThis, 'fetch', (path: string) =>
    Promise.resolve(path === '/api/auth/password' ? unauthorized() : ok()));
  await assert.rejects(changePassword('错的', '新的密码够长了', new AbortController().signal), ApiError);
  assert.equal(expired, 1, '广播照常——由登录关卡决定怎么提示');
  assert.equal(isLoggedOut(), false, '把闸关在这儿会掐掉一个仍然登录着的人的全部轮询');
  await request('/api/workspace');
});

test('旧 cookie 的迟到 401 不能在登录成功之后把闸关上', async t => {
  let release!: (r: Response) => void;
  t.mock.method(globalThis, 'fetch', (path: string) => path === '/slow'
    ? new Promise<Response>(resolve => { release = resolve; })
    : Promise.resolve(ok()));
  const slow = assert.rejects(request('/slow'), ApiError);
  acceptAuthenticatedSession();          // 中途登录成功，cookie 换了
  release(unauthorized()); await slow;
  assert.equal(isLoggedOut(), false, '迟到的 401 属于上一个 cookie，不该撤销这次登录');
});

test('查出来「本来就登录着」也要开闸——否则是一条走不出去的死路', async t => {
  /*
    闸因为一发 401 关上（后端重启、网络抖一下都可能），而 cookie 其实一直有效。
    这一次 /api/auth/session 回 200 说你登录着，界面解锁了，**但闸还关着**——
    所有轮询继续被短路，页面从此不更新，而且不报错。开闸原本只挂在 login 上，
    这条路走不到那儿。
  */
  const { fetchAuthSession } = await import('../src/shared/api/auth.ts');
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', (path: string) => {
    seen.push(path);
    return Promise.resolve(path === '/api/auth/session'
      ? Response.json({ configured: true, authenticated: true, secureCookie: false })
      : seen.filter(p => p === '/api/workspace').length === 1 ? unauthorized() : ok());
  });
  await assert.rejects(request('/api/workspace'), ApiError);
  assert.equal(isLoggedOut(), true);

  const session = await fetchAuthSession();
  assert.equal(session.authenticated, true);
  assert.equal(isLoggedOut(), false, '服务器刚说这个 cookie 能用，闸就该开');

  const after = seen.length;
  await request('/api/workspace');
  assert.equal(seen.length, after + 1, '开闸之后轮询要能出网');
});

test('检查发现没登录，闸保持关着', async t => {
  t.mock.method(globalThis, 'fetch', (path: string) => Promise.resolve(path === '/api/auth/session'
    ? Response.json({ configured: true, authenticated: false, secureCookie: false })
    : unauthorized()));
  const { fetchAuthSession } = await import('../src/shared/api/auth.ts');
  await assert.rejects(request('/api/workspace'), ApiError);
  await fetchAuthSession();
  assert.equal(isLoggedOut(), true, 'authenticated:false 不该开闸');
});
