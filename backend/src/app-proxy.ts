/*
  把本机某个端口上的服务，转发到 roost 自己的地址下，好让它能被放进一个浮动窗口。

  **为什么必须有这一层。** 用户从公网访问 roost，浏览器在他那一侧，连不到这台机器的
  `127.0.0.1:5173`。所以「端口变成应用窗口」不是把 localhost 塞进 iframe 就行——
  每一个要开成窗口的端口都得经这里转一道。本机 23 个监听端点里 13 个只绑回环，
  一个都不能直连。

  **口子开多大是用户拍板的：全开。** 我提过风险——roost 在公网上只有一道密码，而这些
  本机服务大多没有自己的认证（最典型的是那个命令行里明写着 `listen_addresses=127.0.0.1`
  的 postgres，是运维方特意限制的，转发过去等于替它推翻了这个决定）。用户知情并选择了
  全开，所以这里不做端口白名单。**但凡是能在这一层收紧而不影响功能的，一律收紧**，
  见下面 `forwardHeaders` 和 `scopeCookies`。
*/
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/** 转发的目标永远是回环。端口是个数字，所以「只转本机」这条是靠类型保证的，不是靠检查。 */
const TARGET_HOST = '127.0.0.1';
const PREFIX = '/api/app/';
/** 目标没起来时不要挂着——iframe 里一个转圈的空白页比一句「连不上」难查得多。 */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * `/api/app/5173/foo?x=1` → `{ port: 5173, path: '/foo?x=1' }`。
 *
 * 认不出就是 null。端口必须是纯十进制且在 1..65535——`0`、`+80`、`080`、`8080abc`
 * 全部拒绝，不做「尽量解析」：一个被猜出来的端口号会把请求转给完全不相干的服务。
 */
export function parseAppPath(url: string): { port: number; path: string } | null {
  if (!url.startsWith(PREFIX)) return null;
  const rest = url.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  const query = rest.indexOf('?');
  // 端口段在第一个 `/` 或 `?` 之前。两者都没有时，整段就是端口（`/api/app/5173`）。
  const end = slash < 0 ? (query < 0 ? rest.length : query) : (query < 0 ? slash : Math.min(slash, query));
  const digits = rest.slice(0, end);
  if (!/^[1-9]\d{0,4}$/.test(digits)) return null;
  const port = Number(digits);
  if (port > 65535) return null;
  const tail = rest.slice(end);
  // 目标看到的路径永远以 `/` 开头：`/api/app/5173?x=1` 要变成 `/?x=1`，不是 `?x=1`。
  return { port, path: tail.startsWith('/') || tail === '' ? (tail || '/') : '/' + tail };
}

/**
 * 应用用绝对路径引资源时（`/assets/x.js`），靠 Referer 认出它属于哪个应用。
 *
 * **不这么做的话，绝大多数应用一放进窗口就白屏**：它们生成的是 `/assets/…` 这种从根
 * 算起的地址，前缀丢了，请求会落到 roost 自己身上。
 *
 * 这条判据是安全的，因为**方向是单向的**：roost 自己的页面永远不会带上一个
 * `/api/app/<port>/` 的 Referer，所以它不可能被这条规则劫走；而带着这种 Referer 的请求
 * 本来就来自那个应用的 iframe。认不出就返回 null，交还给 roost 的正常路由。
 */
export function refererPort(referer: string | undefined): number | null {
  if (!referer) return null;
  let path: string;
  try { path = new URL(referer).pathname; } catch { return null; }
  return parseAppPath(path)?.port ?? null;
}

/*
  逐跳首部：按 HTTP 规范它们只属于**这一跳**，原样转出去会让下游行为错乱
  （比如把 `connection: keep-alive` 转给目标，再由目标回一个自己的，两边对不上）。
*/
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * 转给目标的请求首部。
 *
 * **这里最要紧的一件事：把 roost 自己的会话 cookie 摘掉。** 不摘的话，每一个被代理的
 * 本机服务都会收到 `roost_session=<令牌>`——那是能完整登录 roost 的凭据，而这些服务
 * 大多是随手起的开发服务器，会把请求首部原样打进日志里。一个为了看页面而开的窗口，
 * 不该把整个 roost 的钥匙交出去。
 *
 * `host` 改写成目标自己的：很多框架用它生成绝对 URL 和做 Host 校验（vite 的
 * `server.allowedHosts` 就会拿它挡）。
 */
export function forwardHeaders(headers: IncomingMessage['headers'], port: number,
  authCookieName: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (name === 'host') continue;
    if (name === 'cookie') {
      const kept = (Array.isArray(value) ? value.join('; ') : value)
        .split(';').map(part => part.trim())
        .filter(part => part && !part.startsWith(authCookieName + '='));
      if (kept.length) out.cookie = kept.join('; ');
      continue;
    }
    out[name] = value;
  }
  out.host = `${TARGET_HOST}:${port}`;
  return out;
}

/**
 * 应用回的 `Set-Cookie` 要限定在它自己的路径下。
 *
 * 它们是设在 **roost 的源** 上的——不限定路径的话，一个应用种下的 cookie 会被送到
 * roost 本身和**其他每一个**被代理的应用那里。两个应用都用 `session=` 这个名字就会
 * 互相覆盖，而这种串扰查起来能查一整天。
 *
 * 一并去掉 `domain`（应用眼里的域名不是 roost 的域名，留着它浏览器会直接丢弃整条）
 * 和 `secure`（roost 可能跑在纯 HTTP 上，留着同样会被丢弃）。
 */
export function scopeCookies(values: string[] | undefined, port: number): string[] | undefined {
  if (!values?.length) return values;
  return values.map(value => {
    const parts = value.split(';').map(part => part.trim())
      .filter(part => part && !/^(path|domain|secure)\s*(=|$)/i.test(part));
    parts.push(`Path=${PREFIX}${port}/`);
    return parts.join('; ');
  });
}

/** 目标回了个指向自己根目录的跳转时，把它改写到这个应用的前缀下。 */
export function rewriteLocation(location: string | undefined, port: number): string | undefined {
  if (!location) return location;
  // 只改「从根算起的相对地址」。绝对 URL 和 `../x` 这种原样透出——猜错一个跳转目标
  // 比不改更糟，那会把人送到另一个应用里去。
  return location.startsWith('/') && !location.startsWith('//') ? `${PREFIX}${port}${location}` : location;
}

export function createAppProxy(authCookieName: string) {
  /** 普通 HTTP 请求。**全程流式**：不缓冲，大响应和 SSE 都要能过。 */
  function handle(req: IncomingMessage, res: ServerResponse, port: number, path: string): void {
    const upstream = httpRequest({ host: TARGET_HOST, port, path, method: req.method,
      headers: forwardHeaders(req.headers, port, authCookieName) }, response => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        if (name === 'set-cookie') { const scoped = scopeCookies(value as string[], port); if (scoped) headers[name] = scoped; continue; }
        if (name === 'location') { const next = rewriteLocation(value as string, port); if (next) headers[name] = next; continue; }
        headers[name] = value;
      }
      /*
        `x-frame-options` / CSP 的 `frame-ancestors` 原样透出，**不剥**。

        剥掉它们就是替对方拆掉点击劫持防护，而那是它自己选的。实测本机这几个服务
        （5173/5199/8080/55146）一个都没设，所以现在也不需要剥；真碰到设了的（Jupyter
        是已知的一个），那是要单独想清楚的一件事，不是在这里顺手做掉的。
      */
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
    });
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (res.headersSent) { res.destroy(); return; }
      // 分开说：端口上没东西 vs 连上了但出错。前者是最常见的情况（服务已经退了）。
      const gone = error.code === 'ECONNREFUSED';
      res.writeHead(gone ? 502 : 504, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { code: gone ? 'app_not_listening' : 'app_unreachable',
        message: gone ? `Nothing is listening on port ${port}` : `Port ${port} did not respond` } }));
    });
    req.pipe(upstream);
  }

  /**
   * WebSocket 升级。手写一次 upgrade 握手再把两条 socket 对接起来。
   *
   * 这一条不能省：vite 的热更新、Jupyter 的内核通道都走 ws，不转的结果是页面能打开、
   * 但一动就报错——比彻底打不开更难查。
   *
   * **注意：这条路只认显式前缀，没有 Referer 兜底。** 浏览器发 WebSocket 握手时不带
   * Referer（只带 Origin），所以上面那条对绝对路径的救济在这里用不了。应用把 ws 地址
   * 写成从根算起的绝对地址时，这一条会落到 roost 自己身上——那是这一版已知的边界。
   */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number, path: string): void {
    const upstream = httpRequest({ host: TARGET_HOST, port, path, method: 'GET',
      headers: { ...forwardHeaders(req.headers, port, authCookieName),
        connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' } });
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
      for (const [name, value] of Object.entries(response.headers)) {
        for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) lines.push(`${name}: ${one}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead?.length) socket.unshift(upstreamHead);
      // 两条 socket 任一断开都要把另一条也拆掉，否则半开的连接会一直挂着。
      const close = () => { socket.destroy(); upstreamSocket.destroy(); };
      socket.on('error', close); upstreamSocket.on('error', close);
      socket.on('close', close); upstreamSocket.on('close', close);
      upstreamSocket.pipe(socket); socket.pipe(upstreamSocket);
    });
    upstream.on('response', () => { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    upstream.on('error', () => { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    if (head?.length) upstream.write(head);
    upstream.end();
  }

  return { handle, handleUpgrade };
}
