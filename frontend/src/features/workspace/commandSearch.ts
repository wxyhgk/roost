import { walkTree } from "../../shared/api";

export type Item =
  | { kind: "session"; id: string; title: string; sub: string; closed: boolean }
  | { kind: "file"; id: string; title: string; sub: string }
  | { kind: "note"; id: string; title: string; sub: string }
  | { kind: "snippet"; id: string; title: string; sub: string };

const WALK_TTL = 45_000;

export type WalkFile = { path: string; name: string };
const walkCache = new Map<string, { at: number; files: WalkFile[] }>();

/**
 * 列出 root 下的文件，给下面的模糊匹配用。
 *
 * 遍历在**服务端**做。以前是前端逐层 `listDir`：层内并行、层间串行，实测这个仓库
 * 106 个请求、6 层——HTTP/2 上光往返 2 秒，HTTP/1.1（每源 6 连接）近 6 秒。
 * 而且关掉面板不会取消，那 106 个请求会在后台跑完、占着连接挡住用户真正在等的东西。
 *
 * 深度、条数、跳过哪些目录全由服务端决定（见 backend/src/fs.ts 的 walkFiles）——
 * 那些是遍历策略，属于知道磁盘长什么样的那一侧。
 *
 * 缓存留着：面板反复开关时不必每次重走一遍。`signal` 用于面板关闭时中止。
 */
export async function walkFiles(root: string, signal?: AbortSignal): Promise<WalkFile[]> {
  const cached = walkCache.get(root);
  if (cached && Date.now() - cached.at < WALK_TTL) return cached.files;
  const { files } = await walkTree(root, signal);
  walkCache.set(root, { at: Date.now(), files });
  return files;
}

// 子序列模糊：连续/开头/边界加权，不匹配返回 -1。
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let consec = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found < 0) return -1;
    if (found === ti) {
      consec++;
      score += 10 + consec * 5;
    } else {
      consec = 0;
      score += 5;
      const prev = t[found - 1];
      if (found === 0 || prev === "/" || prev === " " || prev === "-" || prev === "_") score += 8;
    }
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 20;
  return score;
}

// 文件分层：文件名包含（2xxx）> 路径包含（1xxx）> 文件名模糊（raw）；长串跨路径子序列不算。
export function matchFile(query: string, name: string, path: string): number {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n.includes(q)) return 2000 + (n.startsWith(q) ? 50 : 0) - n.length * 0.01;
  if (path.toLowerCase().includes(q)) return 1000;
  return fuzzyScore(query, name);
}

export function matchItem(q: string, title: string, sub: string): number {
  if (!q) return 1;
  return Math.max(fuzzyScore(q, title), sub ? fuzzyScore(q, `${title} ${sub}`) : -1);
}
