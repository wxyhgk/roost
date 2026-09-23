import type { IncomingMessage } from "node:http";

export type AccessOptions = { allowedOrigins?: string[]; allowedHostnames?: string[] };

function origin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) throw new Error("Expected an exact HTTP(S) origin");
  return url.origin;
}

/*
  **同源，从请求自身推导——没有名单。**

  这里原来是一份要配的来源名单（`ROOST_ALLOWED_ORIGINS`）。它之所以存在，是因为后端在
  反向代理后面：caddy 保留原始 `Host: 203.0.113.4:8080` 转给 127.0.0.1:8787，于是
  「Host 的端口 === 本地端口」永远对不上，只能靠名单开后门。名单于是变成了必须手工维护
  的东西——换个网段、多一个 Tailscale 地址、以后加个域名，都要改一次；漏了就是**整个连
  不上**，而且报的是 403，看起来像别的毛病。2026-09-22 就这么坏过一次：一次安装重写了
  plist、丢掉了局域网地址，界面打得开（静态外壳走 caddy）但所有 WebSocket 全挂。

  改成比对请求自己的 `Origin` 和 `Host` 之后，代理那个端口错配自然消失，名单也就不需要
  了：局域网地址、Tailscale 地址、localhost、以后任何域名**全自动生效，一个字不用配**。

  **它挡的东西一点没少，而且更准。** 要挡的是：你浏览器里打开的任意网站对
  `ws://<roost>/api/pty` 发起连接——WebSocket 没有 CORS 预检拦得住，浏览器会自动带上你的
  登录 cookie，对方就能读写你所有终端（跑着 shell 和有完整文件权限的 AI CLI）。那种请求
  的 `Origin` 是攻击者的站点，永远不等于你的 `Host`，照样被拒。

  **凭据和同源是绑在一起的**，这是这套判定的核心：浏览器对跨源的 WebSocket 升级和写操作
  必定发 `Origin`，所以带 cookie 的危险动作一定要过同源这一关；而同源 GET 导航浏览器**不
  发** `Origin`，那条路只用来取外壳，放行是必须的也是无害的。

  DNS 重绑定（攻击者的域名解析到这台机器）现在能走到认证墙前面，但**走不进去**：cookie
  是按设置它的来源划域的，`evil.test` 上的页面拿不到给 `203.0.113.4` 发的那张，于是只会
  吃 401。用「名单」去挡它，代价是上面那份手工维护，不划算。
*/
export function createAccessPolicy(_options: AccessOptions = {}) {
  /*
    开发模式是**真的跨源**：vite 在 5173，后端在 8787，同源判定必然不成立。
    只放行这两个写死的回环地址——它们指向本机，不是可配置的口子。
  */
  const devOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
  return (req: IncomingMessage): { allowed: boolean; headers: Record<string, string> } => {
    const headers: Record<string, string> = { vary: "Origin" };
    const deny = () => ({ allowed: false, headers });
    try {
      const host = req.headers.host;
      if (!host || /[\s/@\\?#]/.test(host)) return deny();
      // 必须原样往返：`user@h`、`h/path`、`h#x` 这类含糊的 authority 一律不认。
      if (new URL(`http://${host}`).host !== host) return deny();
      const requested = req.headers.origin;
      if (requested !== undefined) {
        if (typeof requested !== "string") return deny();
        const normalized = origin(requested);
        if (new URL(normalized).host !== host && !devOrigins.has(normalized)) return deny();
        headers["access-control-allow-origin"] = normalized;
        headers["access-control-allow-credentials"] = "true";
        headers["access-control-allow-methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
        headers["access-control-allow-headers"] = "content-type";
      } else if (req.headers["sec-fetch-site"] === "cross-site"
        || (req.headers.cookie && (req.headers.upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')))) return deny();
      return { allowed: true, headers };
    } catch { return deny(); }
  };
}
