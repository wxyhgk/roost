import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, changePassword } from '../src/shared/api/auth.ts';
import { request, onSessionExpired } from '../src/shared/api/request.ts';
import { ApiError } from '../src/shared/api/errors.ts';
const authenticated = () => Response.json({ configured: true, authenticated: true, secureCookie: false });
const unauthorized = () => Response.json({ error: { code: 'unauthorized', message: 'login required' } }, { status: 401 });

for (const action of ['login', 'password'] as const) {
  test(`${action} success fences an older 401, but fresh expiry still opens login`, async t => {
    let oldResponse!: (response: Response) => void, expired = 0;
    t.after(onSessionExpired(() => { expired++; }));
    t.mock.method(globalThis, 'fetch', (path: string) => path === '/old'
      ? new Promise<Response>(resolve => { oldResponse = resolve; })
      : Promise.resolve(path.startsWith('/api/auth/') ? authenticated() : unauthorized()));
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
    : Promise.resolve(path === '/read' ? Response.json({ ok: true }) : unauthorized()));
  const old = assert.rejects(request('/old'), ApiError);
  await assert.rejects(login('fixture wrong'), ApiError); assert.equal(expired, 1);
  await request('/read'); oldResponse(unauthorized()); await old;
  assert.equal(expired, 2);
});
