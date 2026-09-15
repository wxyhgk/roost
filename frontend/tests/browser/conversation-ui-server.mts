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
const say = (role: string, parts: unknown[], content = '') =>
  bridge.publish('fixture-shell', { eventId: `e${++seq}`, type: 'message', role, content, data: { parts } } as never,
    { cursor: seq, hasGap: false });

say('user', [{ type: 'text', text: '把 xyz 解析器里那个空行的兜底删掉，顺便跑一下测试。' }]);
say('assistant', [{ type: 'text', text: '我先看一眼那段代码，然后改掉它并跑测试。' }]);

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
say('user', [{ type: 'tool_error', toolCallId: 't6', text: Array.from({ length: 40 }, (_, i) => `✔ 用例 ${i + 1} 通过 (0.${i}ms)`).join('\n') + '\n✖ 空行兜底删掉之后，后面的原子跟着消失\n  AssertionError: 3 !== 1\n\nℹ fail 1' }]);

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

say('assistant', [{ type: 'text', text: '空行那条兜底**不能删**：`parse.ts` 里它挡的是原子块中间的空行。删掉之后 `break` 会让后面的原子整片消失，`xyz-parse.test.ts` 里那条「原子块中间的空行跳过」当场就红了。\n\n我把它改回 `continue` 了，测试重新全绿。' }]);

bridge.unbind('fixture-shell');

const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir, access: { allowedOrigins: ['http://127.0.0.1:5175'] } });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const vite = await createServer({ root: resolve('frontend'), configFile: resolve('frontend/vite.config.ts'),
  server: { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${port}`, ws: true, changeOrigin: true } } } });
await vite.listen();
console.log('http://127.0.0.1:5175/tests/browser/conversation-ui.html');
async function stop() { await vite.close(); server.closeAllConnections(); server.close(); runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); process.exit(); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
