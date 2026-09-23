import type { IncomingMessage } from 'node:http';
/*
  同源，从请求自身推导——**没有名单**。和 backend/src/access.ts 同一套判据，理由写在那边。

  这里原来除了名单还多一道「Host 必须是回环地址、且端口等于本地端口」。在反向代理后面
  那一条永远不成立：caddy 保留原始 `Host: <局域网地址>:8080` 转给 127.0.0.1 上的另一个
  端口。于是要么配名单，要么整条连不上。

  比对请求自己的 `Origin` 和 `Host` 就没有这个错配。挡的东西没少：第三方站点发起的
  WebSocket，`Origin` 是它自己，永远不等于你的 `Host`。
*/
export function createCoreAccess() {
  // 开发模式是真的跨源：vite 在 5173，这里在别的端口。只放行这两个写死的回环地址。
  const devOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
  return (req: IncomingMessage) => {
    try {
      const host = req.headers.host;
      if (!host || /[\s/@\\?#]/.test(host)) return false;
      // 必须原样往返：含糊的 authority（`user@h`、`h/path`、`h#x`）一律不认。
      if (new URL('http://' + host).host !== host) return false;
      const origin = req.headers.origin;
      if (origin === undefined) return req.headers['sec-fetch-site'] !== 'cross-site';
      if (typeof origin !== 'string') return false;
      const url = new URL(origin);
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return false;
      return url.host === host || devOrigins.has(origin);
    } catch { return false }
  };
}
