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
say('user', [{ type: 'tool_result', toolCallId: 't1', text: 'export function parseXyz(content: string) {\n  const lines = content.split(/\\r\\n|\\r|\\n/);\n  …' }]);

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

bridge.unbind('fixture-shell');

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
