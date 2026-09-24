import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAppPath, refererPort, forwardHeaders, scopeCookies, rewriteLocation } from '../src/app-proxy.ts';

/*
  路径解析。**端口号解析错的代价是把请求转给完全不相干的服务**，所以这里一律严格，
  不做「尽量解析」。
*/
test('认出端口和剩下的路径', () => {
  assert.deepEqual(parseAppPath('/api/app/5173/foo/bar?x=1'), { port: 5173, path: '/foo/bar?x=1' });
  assert.deepEqual(parseAppPath('/api/app/8080/'), { port: 8080, path: '/' });
});

test('没有尾巴时目标路径也要是 /', () => {
  // `/api/app/5173` 转过去必须是 `/`，不是空串——空路径的请求行是非法的。
  assert.deepEqual(parseAppPath('/api/app/5173'), { port: 5173, path: '/' });
  assert.deepEqual(parseAppPath('/api/app/5173?x=1'), { port: 5173, path: '/?x=1' });
});

test('不是十进制端口的一律拒绝,不猜', () => {
  for (const url of ['/api/app/0/', '/api/app/080/', '/api/app/+80/', '/api/app/8080abc/',
    '/api/app/-1/', '/api/app//', '/api/app/', '/api/app/1e3/']) {
    assert.equal(parseAppPath(url), null, url);
  }
});

test('超出端口范围的拒绝', () => {
  // 65535 是边界,要收;65536 越界。只拿「不是数字」当反例测不到范围判断。
  assert.equal(parseAppPath('/api/app/65535/')?.port, 65535);
  assert.equal(parseAppPath('/api/app/65536/'), null);
  assert.equal(parseAppPath('/api/app/99999/'), null);
});

test('前缀不对的不接管', () => {
  for (const url of ['/api/apps/5173/', '/app/5173/', '/api/server/ports', '/']) {
    assert.equal(parseAppPath(url), null, url);
  }
});

/* 绝对路径的 Referer 救济。 */
test('从 Referer 认出应用', () => {
  assert.equal(refererPort('http://host:8080/api/app/5173/index.html'), 5173);
  assert.equal(refererPort('http://host:8080/api/app/5173/'), 5173);
});

test('roost 自己页面的 Referer 认不出来——这条规则是单向的', () => {
  /*
    这是这条判据安全的**全部理由**：roost 自己的页面永远不会带上一个 `/api/app/<port>/`
    的 Referer，所以它的 `/assets/x.js` 不可能被劫到某个应用上去。
  */
  assert.equal(refererPort('http://host:8080/'), null);
  assert.equal(refererPort('http://host:8080/assets/main.js'), null);
  assert.equal(refererPort(undefined), null);
  assert.equal(refererPort('这不是一个 URL'), null);
});

/* 首部过滤。这一组是这个文件里安全权重最高的。 */
test('绝不把 roost 的会话 cookie 转给被代理的服务', () => {
  /*
    **不摘的话，每个被代理的本机服务都会收到能完整登录 roost 的凭据**，而它们大多是
    随手起的开发服务器，会把请求首部原样打进日志。一个为了看页面开的窗口不该交出钥匙。
  */
  const headers = forwardHeaders({ cookie: 'roost_session=SECRET; theme=dark' }, 5173, 'roost_session');
  assert.equal(headers.cookie, 'theme=dark');
  assert.ok(!JSON.stringify(headers).includes('SECRET'));
});

test('只剩 roost 的 cookie 时,整条 cookie 首部都不发', () => {
  // 发一个空的 `cookie:` 会让一些服务端框架走进「有 cookie 但解析不出」的分支。
  const headers = forwardHeaders({ cookie: 'roost_session=SECRET' }, 5173, 'roost_session');
  assert.ok(!('cookie' in headers));
});

test('名字只是前缀相同的 cookie 要留下', () => {
  // `roost_session_theme` 不是会话 cookie。按 `名字=` 整段比,不是按 startsWith(名字)。
  const headers = forwardHeaders({ cookie: 'roost_session_theme=dark' }, 5173, 'roost_session');
  assert.equal(headers.cookie, 'roost_session_theme=dark');
});

test('逐跳首部不转发', () => {
  const headers = forwardHeaders({ connection: 'keep-alive', 'transfer-encoding': 'chunked',
    upgrade: 'websocket', 'accept-language': 'zh' }, 5173, 'roost_session');
  for (const name of ['connection', 'transfer-encoding', 'upgrade']) assert.ok(!(name in headers), name);
  assert.equal(headers['accept-language'], 'zh', '普通首部照转');
});

test('host 改写成目标自己的', () => {
  // 很多框架拿 host 生成绝对 URL 或做校验(vite 的 allowedHosts 就会拿它挡)。
  assert.equal(forwardHeaders({ host: 'roost.example:8080' }, 5173, 'roost_session').host, '127.0.0.1:5173');
});

/* 响应侧。 */
test('应用种的 cookie 限定在它自己的路径下', () => {
  /*
    不限定路径的话，一个应用的 cookie 会被送到 roost 本身和**其他每一个**被代理的应用；
    两个应用都叫 `session=` 就会互相覆盖，这种串扰能查一整天。
  */
  const [cookie] = scopeCookies(['session=abc; Path=/; HttpOnly'], 5173)!;
  assert.ok(cookie.includes('Path=/api/app/5173/'));
  assert.ok(!/Path=\/;/.test(cookie), '原来那个 Path=/ 要去掉,不是再追加一个');
  assert.ok(cookie.includes('HttpOnly'), '其余属性原样保留');
});

test('去掉 domain 和 secure——留着浏览器会把整条丢弃', () => {
  // 应用眼里的域名不是 roost 的域名;roost 也可能跑在纯 HTTP 上。
  const [cookie] = scopeCookies(['a=1; Domain=app.local; Secure'], 8080)!;
  assert.ok(!/domain/i.test(cookie));
  assert.ok(!/secure/i.test(cookie));
});

test('没有 Set-Cookie 时原样返回', () => {
  assert.equal(scopeCookies(undefined, 5173), undefined);
  assert.deepEqual(scopeCookies([], 5173), []);
});

test('从根算起的跳转要改写到应用前缀下', () => {
  assert.equal(rewriteLocation('/login', 5173), '/api/app/5173/login');
});

test('绝对 URL 和协议相对地址不动——猜错跳转目标比不改更糟', () => {
  // 改了会把人送进另一个应用,或者送到一个根本不该去的地方。
  assert.equal(rewriteLocation('https://example.com/x', 5173), 'https://example.com/x');
  assert.equal(rewriteLocation('//example.com/x', 5173), '//example.com/x');
  assert.equal(rewriteLocation('../up', 5173), '../up');
  assert.equal(rewriteLocation(undefined, 5173), undefined);
});
