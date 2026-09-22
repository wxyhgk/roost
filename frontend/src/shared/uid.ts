/**
 * RFC 4122 v4 UUID。**没有任何依赖，这是它待在这里的条件**（见 check-boundaries 里
 * `LIBRARY_LEAF_IMPORTS` 那段）。
 *
 * 原来住在 `features/library/api.ts` 里，于是 bookmarks 和 conversations 为了拿一个 id
 * 就得整个特性去认识资料库。代码里当时留了字条：「复用资料库那份 uid：它带了非安全
 * 上下文的 fallback」——那句话本身就是它不属于资料库的自白。
 */
export function uid(): string {
  // crypto.randomUUID 仅在安全上下文（HTTPS 或 localhost）下存在；经 http 端口映射
  // 访问时它是 undefined，直接调用会抛错并让整个资料库不可用。
  // getRandomValues 没有这个限制，用它拼一个符合 RFC 4122 的 v4 UUID。
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
