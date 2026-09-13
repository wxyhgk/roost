import type { IncomingMessage } from "node:http";

export type AccessOptions = { allowedOrigins?: string[]; allowedHostnames?: string[] };
function origin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) throw new Error("Expected an exact HTTP(S) origin");
  return url.origin;
}

export function createAccessPolicy(options: AccessOptions = {}) {
  // OPEN is intentionally ignored. Public origins must be explicitly configured;
  // neither this allowlist nor CORS is a substitute for session authentication.
  const origins = new Set(["http://localhost:5173", "http://127.0.0.1:5173", ...(options.allowedOrigins ?? []).map(origin)]);
  const externalHosts = new Set((options.allowedOrigins ?? []).map(value => new URL(origin(value)).host));
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", ...(options.allowedHostnames ?? []).map(host => {
    const parsed = new URL(`http://${host}`);
    if (parsed.hostname !== host || parsed.host !== host || parsed.pathname !== "/" || parsed.username || parsed.password) throw new Error("Expected a hostname without port");
    return host;
  })]);
  return (req: IncomingMessage): { allowed: boolean; headers: Record<string, string> } => {
    const headers: Record<string, string> = { vary: "Origin" };
    const deny = () => ({ allowed: false, headers });
    try {
      const host = req.headers.host;
      if (!host || /[\s/@\\?#]/.test(host)) return deny();
      const parsed = new URL(`http://${host}`);
      if (!(hosts.has(parsed.hostname) && Number(parsed.port || 80) === req.socket.localPort) && !externalHosts.has(parsed.host)) return deny();
      const requested = req.headers.origin;
      if (requested !== undefined) {
        if (typeof requested !== "string") return deny();
        const normalized = origin(requested);
        const localOrigin = new URL(normalized);
        const ownOrigin = localOrigin.protocol === "http:" && hosts.has(localOrigin.hostname)
          && Number(localOrigin.port || 80) === req.socket.localPort;
        if (!origins.has(normalized) && !ownOrigin) return deny();
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
