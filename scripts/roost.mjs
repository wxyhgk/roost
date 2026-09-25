/*
  `roost` 的命令行：不开浏览器也能问「现在跑着什么」「这条会话叫什么」，并且能改名。

  **为什么要有它。** 这一天里我为了回答同样几个问题手写了六份一次性脚本，用完就扔，
  其中一份因为取错字段给出了错的结论（把只在变化时写库的 `reason` 当成当前状态读）。
  `observe.mjs` 已经把「终端画面 + 写入闸」那一块固定下来了，这一份补另外两块：
  整机在监听什么，以及会话清单——包括**已关闭的**，那些在 GUI 里已经看不见，
  但 id 还在库里，之前找不回来正是因为没有任何地方列得出它们。

  另一层收益是它成了同一批数据的**第二个消费者**。只有一个消费者的接口会静默腐烂：
  今天那两处死代码（`fetchAiControl`、`useTuiComposer`）就是唯一的消费者消失之后留下的。

  **读走本地，写走 HTTP。** 读（端口、会话清单）直接开只读库 + 问守护进程：没有鉴权、
  后端挂了也能用，而且不可能弄坏任何东西。写（改名）**必须**走 `PATCH /api/sessions/:id`，
  因为 `setSessionTitle` 会连带改对话标题（`adoptTerminalTitle`），而这条不变式属于后端；
  CLI 自己开一条读写连接也能调到同一个函数，但那就多了一条绕过后端的写入路径——
  下次谁在后端那一侧加个副作用，这条路就静默落后了。后端不在就直接报错，不偷偷改库。

  用法：
    npm run roost -- ports                  在监听的端口 → 是谁 → 从哪条终端起的
    npm run roost -- sessions [--all]       会话清单；--all 连已关闭的一起列
    npm run roost -- name <会话id> <标题>   改名（终端标题与对话标题一起改）
*/
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { connectTerminalDaemon, daemonSocketPath } from '@roost/terminal-daemon';
import { listeningServices, listeningSockets, normalizeTty, processTable, shortCommand, terminalEnvOwners } from '@roost/terminal-runtime';

const dir = process.env.ROOST_DATA_DIR ?? join(homedir(), '.roost');
const base = process.env.ROOST_BACKEND_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const args = process.argv.slice(2);
const [command, ...rest] = args;
const flag = name => rest.includes(name);
const positional = rest.filter(a => !a.startsWith('--'));

/* 输出宽度跟着真实终端走；管道里没有 columns，退回 80。 */
const width = Math.max(48, process.stdout.columns ?? 80);
/*
  **列宽要按显示宽度算，不能按 `length`。** 中文、全角标点和 `…` 在终端里占两格，
  而 `String.length` 数的是码元：`'已关闭'.length` 是 3，画出来是 6 格。用 padEnd 对齐
  会让每一行的错位量取决于那行有几个汉字，整张表歪掉——这个产品的标题基本全是中文，
  所以这不是边角情况，是常态。第一版就是这么歪的。
*/
const charWidth = code =>
  code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)  // CJK、部首、假名
    || (code >= 0xac00 && code <= 0xd7a3)                     // 谚文
    || (code >= 0xf900 && code <= 0xfaff)                     // CJK 兼容
    || (code >= 0xfe30 && code <= 0xfe6f)                     // 全角标点
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f9ff))                  // emoji
    ? 2 : 1;
const displayWidth = text => [...(text ?? '')].reduce((sum, ch) => sum + charWidth(ch.codePointAt(0)), 0);
/** 截到至多 n 格宽；截断时留一格给 `…`（它自己占两格）。 */
const cut = (text, n) => {
  if (displayWidth(text) <= n) return text ?? '';
  let out = '', used = 0;
  for (const ch of text ?? '') {
    const next = used + charWidth(ch.codePointAt(0));
    if (next > n - 2) break;
    out += ch; used = next;
  }
  return out + '…';
};
const pad = (text, n) => { const value = cut(text, n); return value + ' '.repeat(Math.max(0, n - displayWidth(value))); };

function openDatabase() {
  // 只读打开：这个进程绝不该成为第二个写者，而 readOnly 是唯一能让这件事在
  // 打错一行代码时**也**成立的写法。
  return new DatabaseSync(join(dir, 'workspace.sqlite'), { readOnly: true });
}

/** 会话 id → 标题。已关闭的也在里面，端口归属才认得出它们。 */
function sessionTitles(db) {
  const map = new Map();
  for (const row of db.prepare('select id, title, closed, cwd from sessions').all()) {
    map.set(row.id, { title: row.title, closed: !!row.closed, cwd: row.cwd });
  }
  return map;
}

/**
 * 各条 PTY 的控制终端。
 *
 * 只有**活着的**会话才有 tty——守护进程里没有这条记录就是进程已经没了。所以这里必须
 * 问守护进程，不能从库里读：库里存的是会话，tty 属于当下那个进程。
 */
async function ptyTtys() {
  const owners = new Map();
  let client;
  try { client = await connectTerminalDaemon(daemonSocketPath(dir)); }
  catch { return { owners, reachable: false }; }
  try {
    for (const session of client.listSessions()) {
      const tty = normalizeTty(session.ptsName);
      if (tty) owners.set(tty, session.id);
    }
  } finally { client.dispose(); }
  return { owners, reachable: true };
}

async function ports() {
  const [rows, probe, { owners: ttyOwners }] = await Promise.all([processTable(), listeningSockets(), ptyTtys()]);
  if (!probe.supported) {
    // 「看不到」和「什么都没跑」是两件事。混同它们就是在撒谎——这条在面板那一侧
    // 也是分开处理的，两边保持一致。
    console.log('这台机器上看不到端口（没有 lsof，或被策略挡住）');
    process.exitCode = 3;
    return;
  }
  const envOwners = await terminalEnvOwners(probe.rows.map(row => row.pid));
  const services = listeningServices({ rows, listeners: probe.rows, envOwners, ttyOwners });
  if (!services.length) { console.log('没有在监听的端口'); return; }
  const db = openDatabase();
  const titles = sessionTitles(db);
  db.close();

  const nameWidth = Math.max(12, width - 42);
  console.log(`${pad('端口', 7)}${pad('进程号', 8)}${pad('命令', nameWidth)} 从哪条终端`);
  for (const service of services) {
    const session = service.terminalId ? titles.get(service.terminalId) : undefined;
    /*
      已关闭的会话也要标出来——「这个端口是我几天前在某条会话里起的，那条会话现在找不到了」
      正是这个工具要回答的问题，而环境变量恰好活得比会话长。
    */
    const from = service.terminalId
      ? `${service.terminalId}${session ? ` ${cut(session.title, 18)}${session.closed ? '（已关闭）' : ''}` : '（会话不在库里）'}`
      : service.tty
        // tty 认得出、但不是 roost 的会话：从系统终端或 ssh 起的。
        ? service.tty
        : '—';
    console.log(`${pad(String(service.port ?? '?'), 7)}${pad(String(service.pid), 8)}${pad(shortCommand(service.command) ?? '（进程已退出）', nameWidth)} ${from}`);
  }
  console.log(`\n共 ${services.length} 个监听端点 · 只列你自己起的进程`);
}

async function sessions() {
  const db = openDatabase();
  const rows = db.prepare('select id, title, closed, cwd from sessions order by closed, seq').all();
  db.close();
  const { owners, reachable } = await ptyTtys();
  const live = new Set(owners.values());
  const shown = rows.filter(row => flag('--all') || !row.closed);
  if (!shown.length) { console.log(rows.length ? '没有打开的会话（加 --all 看已关闭的）' : '还没有任何会话'); return; }

  const idWidth = Math.max(...shown.map(row => displayWidth(row.id)));
  const titleWidth = Math.max(10, Math.min(28, width - idWidth - 22));
  for (const row of shown) {
    /*
      状态取自守护进程，不是库里的 `closed`：一条会话可以在库里是「开着」而进程
      早就没了（守护进程重启、进程被 kill）。GUI 里这种会话看着正常却什么都收不到，
      而这一列是唯一能当场说清「它还活着吗」的地方。守护进程本身不在时不硬判——
      那时候**所有**会话都会被算成死的，那是这个工具的问题，不是会话的问题。
    */
    const state = row.closed ? '已关闭' : !reachable ? '（未知）' : live.has(row.id) ? '运行中' : '进程已退出';
    console.log(`${pad(row.id, idWidth)}  ${pad(state, 12)}${pad(row.title, titleWidth)}  ${cut(row.cwd.replace(homedir(), '~'), Math.max(8, width - idWidth - titleWidth - 18))}`);
  }
  const closed = rows.length - shown.length;
  console.log(`\n共 ${shown.length} 条${closed ? ` · 另有 ${closed} 条已关闭（--all 可见）` : ''}`);
}

/*
  带凭据的请求。

  **cookie 要缓存下来复用。** 后端对同时存在的登录会话有上限，而每次登录都会新占一个
  槽位（旧 cookie 没带上时不会被顶掉），所以「每跑一次命令登录一次」跑上几十次就会撞到
  `auth_capacity`，把浏览器那一侧一起挤下去。

  另外后端有一道 15 分钟的配额窗口（`backend/src/auth.ts` 的 `allowAttempt`）：**成功的
  尝试也计数**，不是「失败才罚」。每个来源地址 10 次、全局 100 次，而挑战-响应登录要花两
  次（领挑战和登录各算一次），也就是每 15 分钟只有 5 次完整登录。所以密码错了就停，不重试
  ——真重试几下，这台机器上的浏览器也一起登不进来了。
*/
const cookiePath = join(dir, '.cli-cookie');

async function authorized() {
  let cookie = await readFile(cookiePath, 'utf8').then(text => text.trim()).catch(() => '');
  const ok = async value => {
    if (!value) return false;
    const res = await fetch(`${base}/api/auth/session`, { headers: { cookie: value } });
    return res.ok && (await res.json()).authenticated === true;
  };
  if (await ok(cookie)) return cookie;
  const password = await readFile(join(dir, 'auth-password'), 'utf8').then(text => text.trim());
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`登录失败：${res.status} ${(await res.text()).slice(0, 120)}`);
  cookie = (res.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('登录成功但没拿到 cookie');
  await writeFile(cookiePath, cookie + '\n', { mode: 0o600 });
  return cookie;
}

async function rename() {
  const [id, ...words] = positional;
  const title = words.join(' ').trim();
  if (!id || !title) { usage(); process.exitCode = 2; return; }
  const db = openDatabase();
  const existing = db.prepare('select title from sessions where id=?').get(id);
  db.close();
  // 先确认 id 存在再登录：打错一个 id 不该换来一句 404，更不该白占一个登录会话。
  if (!existing) { console.error(`没有这条会话：${id}（npm run roost -- sessions --all 看全部）`); process.exitCode = 4; return; }
  const cookie = await authorized();
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie, origin: base },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`改名失败：${res.status} ${(await res.text()).slice(0, 200)}`);
  console.log(`${id}：「${existing.title}」→「${(await res.json()).title}」`);
  console.log('终端标题和对话标题一起改了。');
}

function usage() {
  console.log(`用法：
  npm run roost -- ports                  在监听的端口 → 是谁 → 从哪条终端起的
  npm run roost -- sessions [--all]       会话清单；--all 连已关闭的一起列
  npm run roost -- name <会话id> <标题>   改名（终端标题与对话标题一起改）

读操作直接看本地库和守护进程，后端不在也能用；改名要走后端（${base}）。`);
}

const commands = { ports, sessions, name: rename };
const run = commands[command];
if (!run) { usage(); process.exitCode = command ? 2 : 0; }
else await run().catch(error => { console.error(error.message); process.exitCode = 1; });
