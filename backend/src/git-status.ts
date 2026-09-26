import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import type { WorkspaceStore } from '@roost/workspace-store';
import { sendError } from './http';

/*
  `GET /api/sessions/:id/changes` —— 这个终端的工作目录里有哪些未提交的改动。

  **它回答的是你打开 roost 时真正想问的那个问题。** agent 说「做完了」之后，最便宜的证据
  不是它的总结，是它到底碰了哪些文件。这条在手机上尤其值：一个数字就答完了，不用读一屏
  TUI。

  **名字要准：是「未提交的改动」，不是「这个会话改的」。** `git status` 比的是工作区和
  HEAD，跨越会话边界；agent 很少提交，所以实践中两者基本重合，但它们不是一回事，界面上
  也照这个说法写。要做到真正的「这个会话改的」得在会话开始时记一个 ref，那是另一件事。

  安全上三条：
  - 目录来自 PTY 自己报的 cwd（`session.cwd`），不接受调用方传路径——传路径就等于开了一个
    「在任意目录跑 git」的口子。
  - `execFile` 传参数数组，不经过 shell。
  - 限时 2 秒、限输出 1 MiB：仓库可能很大，或者挂在一个不响应的网络盘上，那时候**慢比错
    更难查**，宁可回一句「超时」。
*/

const TIMEOUT_MS = 2000;
const MAX_BUFFER = 1024 * 1024;
/** 最多回多少条文件名。数量本身照实报，列表截断——面板上也放不下更多。 */
const MAX_FILES = 200;

export type ChangeEntry = { path: string; status: string };
export type ChangeSummary =
  | { kind: 'clean' }
  | { kind: 'dirty'; modified: number; added: number; deleted: number; untracked: number; files: ChangeEntry[]; truncated: boolean }
  | { kind: 'not-a-repo' }
  | { kind: 'unavailable'; reason: string };

/**
 * 解析 `git status --porcelain=v1 -z` 的输出。
 *
 * **用 `-z` 而不是按行切**：文件名里可以有换行和引号，按行切会在这种文件上安静地错位，
 * 而那正是最难发现的一类错。`-z` 之后记录之间是 NUL，路径原样不转义。
 *
 * 重命名那条会多带一个 NUL 段（旧路径），必须跟着跳过，否则它会被当成下一条记录的
 * 状态码解析，后面全错位。
 */
export function parsePorcelain(out: string): ChangeSummary {
  const parts = out.split('\0');
  const files: ChangeEntry[] = [];
  let modified = 0, added = 0, deleted = 0, untracked = 0;
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // 重命名/复制：下一段是旧路径，不是独立记录。
    if (status[0] === 'R' || status[0] === 'C') i += 1;
    if (status === '??') untracked += 1;
    else if (status.includes('D')) deleted += 1;
    else if (status.includes('A')) added += 1;
    else modified += 1;
    if (files.length < MAX_FILES) files.push({ path, status: status.trim() || status });
  }
  if (!files.length) return { kind: 'clean' };
  return { kind: 'dirty', modified, added, deleted, untracked, files,
    truncated: modified + added + deleted + untracked > files.length };
}

function run(cwd: string): Promise<ChangeSummary> {
  return new Promise(resolve => {
    execFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) { resolve(parsePorcelain(stdout)); return; }
        const text = `${stderr}`;
        // 不是仓库是**正常情况**，不是故障：多数终端的 cwd 根本不在 git 里。
        if (/not a git repository/i.test(text)) { resolve({ kind: 'not-a-repo' }); return; }
        const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
        resolve({ kind: 'unavailable', reason: killed ? 'timeout' : (error as NodeJS.ErrnoException).code ?? 'failed' });
      });
  });
}

export function createGitStatusHandler(store: WorkspaceStore) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/changes$/);
    if (!match) return false;
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); sendError(res, 405, 'method_not_allowed', 'GET required'); return true; }
    const session = store.getSessionRecord(decodeURIComponent(match[1]));
    if (!session) { sendError(res, 404, 'not_found', 'session not found'); return true; }
    const summary = await run(session.cwd);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ cwd: session.cwd, ...summary }));
    return true;
  };
}
