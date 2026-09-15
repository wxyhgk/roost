// 隔离的浏览器 fixture：临时数据目录，碰不到用户的工作区数据库和 daemon。
// 用途是**把对话视图画出来自己看**——单测能钉住规则，钉不住「看着对不对」。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createWorkspaceStore } from '@roost/workspace-store';
import { createAiSessionBridge } from '@roost/ai-session-bridge';
import { createTerminalRuntime } from '@roost/terminal-runtime';
import { createBackendServer } from '../../../backend/src/server.ts';
import { createServer } from 'vite';

const dir = mkdtempSync(join(tmpdir(), 'conversation-ui-'));
const store = createWorkspaceStore({ dataDir: dir });
store.upsertSession({ id: 'fixture-shell', cwd: dir });
const bridge = createAiSessionBridge({ storage: store.aiSessions });
bridge.bind({ webSessionId: 'fixture-shell', terminalInstanceId: 'fixture-pty', cliId: 'claude', nativeSessionId: 'fixture-native' });

const hunk = (lines: string[]) => ({ oldStart: 12, oldLines: 3, newStart: 12, newLines: lines.filter(l => !l.startsWith('-')).length, lines });
let seq = 0;
// usage 的量级照本机实测：缓存读取是大头，未缓存输入只有个位数。
const usage = { inputTokens: 2, outputTokens: 1843, cacheReadTokens: 187432, cacheWriteTokens: 9871, reasoningTokens: 612, model: 'claude-opus-5' };
const say = (role: string, parts: unknown[], content = '') =>
  bridge.publish('fixture-shell', { eventId: `e${++seq}`, type: 'message', role, content,
    data: { parts, ...(role === 'assistant' ? { usage } : {}) }, createdAt: Date.now() - (60 - seq) * 1000 } as never,
    { cursor: seq, hasGap: false });

say('user', [{ type: 'text', text: '把 xyz 解析器里那个空行的兜底删掉，顺便跑一下测试。' }]);
say('assistant', [
  { type: 'thinking', text: '用户说「空行的兜底」，但 parse.ts 里有两处和空行有关：一处是文件末尾的空行，\n另一处是原子块中间的空行。前者是 3Dmol 那个 toUpperCase 崩溃的直接原因，后者挡的是\n手写文件里常见的分节空行。他要删的多半是前者，但措辞分不出来——先把两处都看一眼。' },
  { type: 'text', text: '我先看一眼那段代码，然后改掉它并跑测试。' },
]);

// 一次 Read：只有路径。
say('assistant', [{ type: 'tool_call', toolCallId: 't1', name: 'Read', text: 'Read: {"file_path":"/Users/me/roost/frontend/src/plugins/xyz/parse.ts","offset":40,"limit":60}' }]);
// 读文件的结果是 `cat -n` 那个形状：每行「行号 \t 正文」。真实记录就是这样，
// 前端靠这个形状解出行号、画成带语法高亮的 ReadBlock。
say('user', [{ type: 'tool_result', toolCallId: 't1', text: [
  '40\texport function parseXyz(content: string) {',
  '41\t  const lines = content.split(/\\r\\n|\\r|\\n/);',
  '42\t  const atoms: Atom[] = [];',
  '43\t  for (const line of lines) {',
  '44\t    if (!line.trim()) continue;',
  '45\t    const cols = line.split(/\\s+/);',
  '46\t    if (cols.length < 4) continue;',
  '47\t    atoms.push({ element: cols[0], x: +cols[1], y: +cols[2], z: +cols[3] });',
  '48\t  }',
  '49\t  return { atoms };',
  '50\t}',
].join('\n') }]);

// 一次 Bash 改文件：带 diff（这次新接上的那条路）。
say('assistant', [{ type: 'tool_call', toolCallId: 't2', name: 'Bash', text: 'Bash: {"command":"python3 - <<\'PY\'\\nimport pathlib\\np = pathlib.Path(\'src/plugins/xyz/parse.ts\')\\n…\\nPY"}' }]);
say('user', [{ type: 'tool_result', toolCallId: 't2', text: '改好了', patch: { filePath: 'frontend/src/plugins/xyz/parse.ts', truncated: false, hunks: [
  hunk(['   for (const line of lines) {', '-    if (!line.trim()) continue;', '-    // 空行跳过', '+    if (!line.trim()) break;', '     const cols = line.split(/\\s+/);']),
] } }]);

// 连续三个工具：会被折叠成一组。
for (const [id, name, args, out] of [
  ['t3', 'Grep', 'Grep: {"pattern":"parseXyz","glob":"*.ts","output_mode":"files_with_matches"}', 'frontend/src/plugins/xyz/parse.ts\nfrontend/tests/xyz-parse.test.ts'],
  ['t4', 'Glob', 'Glob: {"pattern":"frontend/tests/*.test.ts"}', 'frontend/tests/xyz-parse.test.ts\nfrontend/tests/conversation-tools.test.ts'],
  ['t5', 'Read', 'Read: {"file_path":"/Users/me/roost/frontend/tests/xyz-parse.test.ts"}', "import { test } from 'node:test';\n…"],
] as const) {
  say('assistant', [{ type: 'tool_call', toolCallId: id, name, text: args }]);
  say('user', [{ type: 'tool_result', toolCallId: id, text: out }]);
}

// 一次失败的命令：长输出。
say('assistant', [{ type: 'tool_call', toolCallId: 't6', name: 'Bash', text: 'Bash: {"command":"npm test --workspace frontend"}' }]);
// 真的带 ANSI 转义：绿色的 ✔、红色的 ✖、暗灰的耗时——命令输出的颜色是有意义的。
const G = '\u001b[32m', R = '\u001b[31m', D = '\u001b[90m', B = '\u001b[1m', Z = '\u001b[0m';
say('user', [{ type: 'tool_error', toolCallId: 't6', text:
  Array.from({ length: 40 }, (_, i) => `${G}✔${Z} 用例 ${i + 1} 通过 ${D}(0.${i}ms)${Z}`).join('\n')
  + `\n${R}✖ 空行兜底删掉之后，后面的原子跟着消失${Z}\n  ${R}AssertionError: 3 !== 1${Z}\n\n${B}ℹ fail 1${Z}` }]);

// 一次被拒绝：命令根本没跑。
say('assistant', [{ type: 'tool_call', toolCallId: 't7', name: 'Bash', text: 'Bash: {"command":"rm -rf frontend/tests"}' }]);
say('user', [{ type: 'tool_denied', toolCallId: 't7', text: 'User rejected tool use' }]);

// MCP：整串名字要被拆开显示。
say('assistant', [{ type: 'tool_call', toolCallId: 't8', name: 'mcp__workspace_messaging__agent_send', text: 'mcp__workspace_messaging__agent_send: {"to":"reviewer","text":"帮我看一眼这个 diff，重点是空行那条兜底为什么不能删","_meta":{"trace":"abc"}}' }]);
say('user', [{ type: 'tool_result', toolCallId: 't8', text: '{"ok":true,"delivered":1}' }]);

// 老数据：预览态只留一个标量（今天之前写进库的都是这样）。
say('assistant', [{ type: 'tool_call', toolCallId: 't9', name: 'Bash', text: 'Bash: npm run verify' }]);
say('user', [{ type: 'tool_result', toolCallId: 't9', text: '' }]);

// 还在跑：没有结果。
say('assistant', [{ type: 'tool_call', toolCallId: 't10', name: 'Bash', text: 'Bash: {"command":"npm run build --workspace frontend"}' }]);

say('user', [{ type: 'compaction', text: '## 这段对话的摘要\n\n用户要求删掉 `parse.ts` 里的空行兜底。经查有两处相关逻辑：\n\n1. 文件末尾的空行——3Dmol 崩溃的直接原因\n2. 原子块中间的空行——手写文件常见的分节写法\n\n已确认第 2 处不能删。' }]);
say('assistant', [{ type: 'text', text: [
  '## 结论',
  '',
  '空行那条兜底**不能删**，理由有三条：',
  '',
  '1. `parse.ts` 里它挡的是**原子块中间**的空行',
  '2. 删掉之后 `break` 会让后面的原子整片消失',
  '3. `xyz-parse.test.ts` 里那条用例当场就红',
  '',
  '| 文件 | 行 | 影响 |',
  '|---|---|---|',
  '| `parse.ts` | 12 | 解析提前结束 |',
  '| `xyz-parse.test.ts` | 81 | 用例失败 |',
  '',
  // 四列及以上的表格会被 render.tsx 打上 md-table-wide，能挣脱消息列摊到整个转录区宽度。
  // 上面那张三列的不会——两张摆在一起，截图里一眼能看出规则有没有生效。
  '| 用例 | 改前 | 改后 | 结论 |',
  '|---|---|---|---|',
  '| 原子块中间有空行 | 3 个原子 | 1 个原子 | 回归 |',
  '| 文件末尾有空行 | 3 个原子 | 3 个原子 | 不变 |',
  '| 全空文件 | 抛错 | 抛错 | 不变 |',
  '',
  '```ts',
  'for (const line of lines) {',
  '  if (!line.trim()) continue;   // 不能改成 break',
  '  const cols = line.split(/\\s+/);',
  '}',
  '```',
  '',
  '> 我把它改回 `continue` 了，测试重新全绿。',
].join('\n') }]);

/*
  `FIXTURE_GAP=1` 时最后再补一条带缺口标记的记录，用来看那条缺口横幅（role="status"，
  说的是「你读到的不是完整记录」）。**默认不开**：缺口是异常态，把它写进默认 fixture
  会让每次截图都顶着一条告警，反而看不出正常态长什么样。
*/
if (process.env.FIXTURE_GAP === '1') {
  bridge.publish('fixture-shell', { eventId: `e${++seq}`, type: 'message', role: 'user', content: '',
    data: { parts: [{ type: 'text', text: '（这条之前有记录没保存下来）' }] }, createdAt: Date.now() } as never,
    { cursor: seq, hasGap: true });
}

/*
  `FIXTURE_LIVE=1` 时**不解绑，并且补一条 active 的 run**：`snapshot.run` 于是非空，
  对话详情给的是真的输入卡（`vendor/dsh/skeleton/InputBar`）而不是「没有在跑的终端」那条
  兜底。默认仍旧解绑——默认 fixture 钉的是「左栏点了一条历史」那个只读场景。

  run 要单独开一次：`snapshot.run` 读的是 `conversation_runs`，而那张表平时由终端守护进程
  在认到活 PTY 之后才写（`conversationRuns.observe`），光 bind 不会有。这里拿存回去的那份
  binding 原样喂进去——`observe` 会逐字段比对 `ai_session_records` 里的当前值，编一个是过不去的。
*/
if (process.env.FIXTURE_LIVE === '1') {
  const record = store.aiSessions.list().find(item => item.binding.webSessionId === 'fixture-shell');
  if (record) store.conversationRuns.observe(record.binding, 'fixture-daemon');
} else {
  bridge.unbind('fixture-shell');
}

/*
  `FIXTURE_EMPTY=1` 时再造一条**一条消息都没有**的活对话。

  这不是编出来的形状：`observeConversation` 看到一次 generation 就建目录行，而
  `last_message_at` 要等第一条记录落库才写。所以「CLI 挂上了终端、但一条记录都没产出」
  就是一条 `lastMessageAt` 为 null 的活对话——本机库里 6 条有 1 条是这样。这里只 bind
  不 publish，复现的就是它。**不解绑**，这样输入卡是真卡（hero 的看点正是那张卡居中）。
*/
if (process.env.FIXTURE_EMPTY === '1') {
  store.upsertSession({ id: 'fixture-empty', cwd: dir });
  bridge.bind({ webSessionId: 'fixture-empty', terminalInstanceId: 'fixture-pty-empty',
    cliId: 'claude', nativeSessionId: 'fixture-native-empty' });
  const record = store.aiSessions.list().find(item => item.binding.webSessionId === 'fixture-empty');
  if (record) store.conversationRuns.observe(record.binding, 'fixture-daemon');
}

const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
/*
  **默认只绑回环。** 这个 fixture 跑的是 `auth: false` 的后端——虽然工作目录是临时目录、
  数据是编的，但它仍然是一个没有认证的文件接口。要从别的机器看就显式给 HOST，
  并且知道自己在做什么。

    HOST=0.0.0.0 node --import tsx frontend/tests/browser/conversation-ui-server.mts
    （端口用 FIXTURE_PORT 改，默认 5175）
*/
const host = process.env.HOST ?? '127.0.0.1';
// 不要用 PORT：这台机器的环境里它已经是后端的 8787，会去抢一个占着的端口。
const port = Number(process.env.FIXTURE_PORT ?? 5175);
// 绑到非回环时来源不止一个（IP、隧道域名…），把 Origin 校验放开——仅限这个隔离 fixture。
const allowedOrigins = host === '127.0.0.1' ? [`http://127.0.0.1:${port}`] : undefined;
const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir, access: { allowedOrigins } });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const backendPort = (server.address() as { port: number }).port;
const vite = await createServer({ root: resolve('frontend'), configFile: resolve('frontend/vite.config.ts'),
  server: { host, port, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, ws: true, changeOrigin: true } } } });
await vite.listen();
console.log(`http://${host === '0.0.0.0' ? '<本机地址>' : host}:${port}/tests/browser/conversation-ui.html`);
async function stop() { await vite.close(); server.closeAllConnections(); server.close(); runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); process.exit(); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
