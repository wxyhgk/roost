import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, changePassword } from '../src/shared/api/auth.ts';
import { request, onSessionExpired } from '../src/shared/api/request.ts';
import { ApiError } from '../src/shared/api/errors.ts';
import { MIN_ITERATIONS } from '@roost/auth-challenge';
const authenticated = () => Response.json({ configured: true, authenticated: true, secureCookie: false });
/*
  登录先要领一次挑战（见 shared/api/auth.ts）。这里给的迭代次数是允许的最小值——
  它只是让 `solveChallenge` 肯算，而这些用例关心的是「401 的先后顺序」，不是派生本身。
  用最小值是为了别让每个用例白白多花几百毫秒。
*/
const challenge = () => Response.json({ nonce: 'AAAA', salt: 'BBBB', iterations: MIN_ITERATIONS });
const unauthorized = () => Response.json({ error: { code: 'unauthorized', message: 'login required' } }, { status: 401 });

for (const action of ['login', 'password'] as const) {
  test(`${action} success fences an older 401, but fresh expiry still opens login`, async t => {
    let oldResponse!: (response: Response) => void, expired = 0;
    t.after(onSessionExpired(() => { expired++; }));
    t.mock.method(globalThis, 'fetch', (path: string) => path === '/old'
      ? new Promise<Response>(resolve => { oldResponse = resolve; })
      : Promise.resolve(path === '/api/auth/challenge' ? challenge()
        : path.startsWith('/api/auth/') ? authenticated() : unauthorized()));
    const old = assert.rejects(request('/old'), error => error instanceof ApiError && error.status === 401);
    if (action === 'login') await login('fixture password');
    else await changePassword('fixture old', 'fixture new', new AbortController().signal);
    oldResponse(unauthorized()); await old;
    assert.equal(expired, 0);
    await assert.rejects(request('/new'), ApiError); assert.equal(expired, 1);
  });
}
test('failed login and ordinary successful reads do not suppress a real expiry', async t => {
  let oldResponse!: (response: Response) => void, expired = 0;
  t.after(onSessionExpired(() => { expired++; }));
  t.mock.method(globalThis, 'fetch', (path: string) => path === '/old'
    ? new Promise<Response>(resolve => { oldResponse = resolve; })
    : Promise.resolve(path === '/read' ? Response.json({ ok: true })
      : path === '/api/auth/challenge' ? challenge() : unauthorized()));
  const old = assert.rejects(request('/old'), ApiError);
  await assert.rejects(login('fixture wrong'), ApiError); assert.equal(expired, 1);
  await request('/read'); oldResponse(unauthorized()); await old;
  assert.equal(expired, 2);
});
