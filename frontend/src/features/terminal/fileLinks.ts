// 纯函数：终端行文本里的文件链接识别 + 跨组件打开发送。
// 保持无 DOM 依赖，以便在 node 单测里直接验证正则与区间。

export type FileLinkMatch = {
  /** 相对或绝对路径原文（不含引号与行号后缀） */
  path: string;
  line?: number;
  /** 在行文本中的半开区间 [start, end)，供 xterm range 使用 */
  start: number;
  end: number;
};

const EXTS = [
  "py", "pyi", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "json", "jsonc", "md", "markdown", "txt", "log", "go", "rs",
  "toml", "yaml", "yml", "ini", "conf", "cfg", "sh", "bash", "zsh",
  "java", "c", "h", "cpp", "hpp", "cc", "rb", "php", "swift", "kt",
  "scala", "r", "jl", "lua", "pl", "xyz", "smi", "mol", "pdb",
  "html", "css", "scss", "vue", "svelte", "svg", "png", "jpg", "jpeg", "webp", "pdf", "sql", "ipynb",
].sort((a, b) => b.length - a.length).join("|");

// Python traceback：File "/a/b.py", line 123
const TRACEBACK = /File "([^"]+)", line (\d+)/g;
// 引号内允许空格；普通路径允许中文。URL 整体排除，避免把网址后缀当文件。
const QUOTED = /(["'`])([^"'`\r\n]+)\1(?::(\d+))?(?::\d+)?/g;
const EXTENSION = new RegExp(`\\.(?:${EXTS})$`, "i");
const GENERIC = new RegExp(
  `(?<![\\p{L}\\p{N}_/~.-])((?:~\\/|\\/|\\.\\/|\\.\\./)?[\\p{L}\\p{N}_.][\\p{L}\\p{N}\\p{M}_.~\\/\\-]*\\.(?:${EXTS}))(?![\\p{L}\\p{N}_.-])(?::(\\d+))?(?::(\\d+))?`,
  "giu",
);

export function matchFileLinks(text: string): FileLinkMatch[] {
  const out: FileLinkMatch[] = [];
  const covered: [number, number][] = [...text.matchAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/gi)].map(m => [m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(TRACEBACK)) {
    const full = m[0];
    const path = m[1];
    const start = (m.index ?? 0) + full.indexOf(path);
    out.push({ path, line: Number(m[2]), start, end: start + path.length });
    covered.push([m.index ?? 0, (m.index ?? 0) + full.length]);
  }
  for (const m of text.matchAll(QUOTED)) {
    const start = m.index! + 1;
    if (covered.some(([s, e]) => start >= s && start < e) || !EXTENSION.test(m[2]) || m[2].includes('://')) continue;
    out.push({ path: m[2], line: m[3] ? Number(m[3]) : undefined, start, end: start + m[2].length });
    covered.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(GENERIC)) {
    const start = m.index ?? 0;
    if (covered.some(([s, e]) => start >= s && start < e)) continue;
    out.push({
      path: m[1],
      line: m[2] !== undefined ? Number(m[2]) : undefined,
      start,
      end: start + m[0].length,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export type BuiltFileLink = {
  /** xterm 列号从 1 开始的半开区间 */
  startX: number;
  endX: number;
  path: string;
  line?: number;
};

export function buildFileLinks(text: string): BuiltFileLink[] {
  return matchFileLinks(text).map((m) => ({
    startX: m.start + 1,
    endX: m.end + 1,
    path: m.path,
    line: m.line,
  }));
}

// 把链接文本归属到会话根目录：返回传给后端 readPreview 的相对路径；
// 跨出根目录、根自己、空串一律拒绝（后端同样会 403，由调用方展示无法打开的原因）。
export function resolveLinkTarget(cwd: string, raw: string): string | null {
  const text = raw.trim();
  if (!text || text.includes("\0")) return null;
  const rel = text.startsWith("/")
    ? text === cwd || !text.startsWith(`${cwd}/`)
      ? null
      : text.slice(cwd.length + 1)
    : text.replace(/^\.\//, "");
  if (rel == null) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === ".." || !p)) return null;
  return parts.join("/");
}
export type FileOpenRequest = {
  sessionId: string;
  /** 链接里的路径原文，由订阅方按会话 cwd 归属解析 */
  path: string;
  line?: number;
};

type Listener = (req: FileOpenRequest) => void;

const listeners = new Set<Listener>();
const openListeners = new Set<Listener>();
let pending: FileOpenRequest | null = null;

/** 外壳只负责展开文件区域，文件视图挂载后再消费请求。 */
export function subscribeFileLinkOpen(fn: Listener): () => void {
  openListeners.add(fn);
  return () => { openListeners.delete(fn); };
}

export function subscribeFileLink(sessionId: string, fn: Listener): () => void {
  const scoped: Listener = req => { if (req.sessionId === sessionId) { if (pending === req) pending = null; fn(req); } };
  listeners.add(scoped);
  if (pending?.sessionId === sessionId) scoped(pending);
  return () => {
    listeners.delete(scoped);
  };
}

export function emitFileLink(req: FileOpenRequest) {
  pending = req;
  for (const fn of [...listeners]) fn(req);
  for (const fn of [...openListeners]) fn(req);
}
