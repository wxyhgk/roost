import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_LAUNCH_TOOLS } from '../src/cli-launch-tools.ts';

/*
  这些工具是**内联进独立启动脚本**的一段文本，没有模块边界可以 import。所以把那段
  文本实例化成函数、注入假的 spawnSync——测到的就是真正会被写进启动脚本的那份代码，
  而不是一份抄过来的副本。

  值得单独钉住是因为这里修的是一个静默失败：版本探测超时时观察者不会装上，而终端里
  CLI 照跑，用户看不到任何提示。见
  issues/2026-09-10-version-probe-timeout-silently-disables-observer.md
*/
type SyncResult = { stdout?: string; error?: { code?: string; message?: string }; signal?: string };
function load(spawnSync: (command: unknown, args: string[], options: { timeout: number }) => SyncResult) {
  const factory = new Function(
    'spawn', 'spawnSync', 'join', 'accessSync', 'constants', 'readFileSync', 'resolve',
    `${CLI_LAUNCH_TOOLS}\nreturn { probeVersion, reportProbeFailure };`,
  );
  return factory(() => {}, spawnSync, () => '', () => {}, {}, () => '', () => '') as {
    probeVersion(command: unknown, timeout: number): { text: string; failed: boolean; reason?: string };
    reportProbeFailure(name: string, reason: string): void;
  };
}
const command = { file: '/fake/cli', args: [] };
const timeout = () => ({ error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' });

test('探测成功就用它的输出，只跑一次', () => {
  const budgets: number[] = [];
  const { probeVersion } = load((_c, _a, o) => { budgets.push(o.timeout); return { stdout: '0.23.1\n' }; });
  assert.deepEqual(probeVersion(command, 2000), { text: '0.23.1\n', failed: false });
  assert.deepEqual(budgets, [2000], '成功时不该有第二次探测');
});

/* 这正是那个 bug 的现场：机器一忙，第一次就越线。重试一次就能救回来。 */
test('第一次超时会用更宽的预算重试，并且成功', () => {
  const budgets: number[] = [];
  let calls = 0;
  const { probeVersion } = load((_c, _a, o) => {
    budgets.push(o.timeout);
    return ++calls === 1 ? timeout() : { stdout: '0.23.1' };
  });
  assert.deepEqual(probeVersion(command, 2000), { text: '0.23.1', failed: false });
  assert.deepEqual(budgets, [2000, 6000], '第二次的预算必须更宽，否则重试没有意义');
});

test('一直超时则报失败，且只探两次——不会没完没了地拖住启动', () => {
  let calls = 0;
  const { probeVersion } = load(() => { calls++; return timeout(); });
  assert.deepEqual(probeVersion(command, 1500), { text: '', failed: true, reason: 'ETIMEDOUT' });
  assert.equal(calls, 2);
});

/* 可执行文件不存在这类错误是立刻返回的，重试它只会白白拖慢每一次启动。 */
test('非超时的错误立刻返回，不重试', () => {
  let calls = 0;
  const { probeVersion } = load(() => { calls++; return { error: { code: 'ENOENT' } }; });
  assert.deepEqual(probeVersion(command, 1500), { text: '', failed: true, reason: 'ENOENT' });
  assert.equal(calls, 1);
});

/*
  「探测失败」和「版本不匹配」必须分得开：后者 failed 为 false，是设计意图，
  不该惊动用户；前者 failed 为 true，要说出来。
*/
test('版本对不上不算失败——那是有意的静默降级', () => {
  const { probeVersion } = load(() => ({ stdout: '9.9.9' }));
  assert.deepEqual(probeVersion(command, 1500), { text: '9.9.9', failed: false });
});

test('失败时往 stderr 写一行，带上原因', () => {
  const { reportProbeFailure } = load(() => ({ stdout: '' }));
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { reportProbeFailure('qwen', 'ETIMEDOUT'); } finally { process.stderr.write = original; }
  assert.equal(written.length, 1);
  assert.match(written[0], /qwen/);
  assert.match(written[0], /ETIMEDOUT/);
  assert.match(written[0], /\n$/);
});

/*
  Windows 上的 .cmd 垫片解析。三个 CLI 在同一台机器上三种形状，而原来只有一种能用：

  - codex：.cmd 背后是 JS —— 唯一走得通的那条
  - claude：.cmd 背后是 claude.exe —— 原来无条件当 JS 跑，变成 `node claude.exe`，
    Node 报 ERR_UNKNOWN_FILE_EXTENSION
  - qwen：.cmd 解析不出来 —— 原来直接掉出循环，报 command not found，
    而 PATH 上明明有 qwen.cmd，这句话把排查带偏了好几轮

  解析出来的东西一律**绕开 cmd.exe** 执行：JS 交给我们自己的 node，原生可执行文件直接跑。
  把 argv 交给 cmd.exe 重新解析正是这个函数存在的理由（CVE-2024-27980 那一类）。
*/
type Resolved = { file?: string; args?: string[]; unusable?: string };
function loadResolver(files: Record<string, string | null>, platform = 'win32') {
  const factory = new Function(
    'process', 'spawn', 'spawnSync', 'join', 'accessSync', 'constants', 'readFileSync', 'resolve', 'dirname',
    `${CLI_LAUNCH_TOOLS}\nreturn { resolveCli, requireCli };`,
  );
  const exists = (path: string) => { if (!(path in files)) throw new Error('ENOENT'); };
  return factory(
    { platform, execPath: 'C:\\roost\\node.exe', env: {}, argv: [], exit: (code: number) => { throw new Error('exit:' + code); } },
    () => {}, () => {},
    (dir: string, name: string) => dir + '\\' + name,
    exists, {},
    (path: string) => { const body = files[path]; if (body == null) throw new Error('EISDIR'); return body; },
    (dir: string, rel: string) => (/^[A-Za-z]:/.test(rel) ? rel : dir + '\\' + rel.replace(/^[\\/]/, '')),
    (path: string) => path.replace(/\\[^\\]*$/, ''),
  ) as { resolveCli(paths: string[], name: string): Resolved | undefined; requireCli(paths: string[], name: string): Resolved };
}

test('一个包着 JS 的 .cmd 垫片交给我们自己的 node（codex 那种）', () => {
  const { resolveCli } = loadResolver({
    'C:\\npm\\codex.cmd': '@echo off\r\n"%~dp0\\node_modules\\codex\\cli.js" %*\r\n',
    'C:\\npm\\node_modules\\codex\\cli.js': '// entry',
  });
  assert.deepEqual(resolveCli(['C:\\npm'], 'codex'), { file: 'C:\\roost\\node.exe', args: ['C:\\npm\\node_modules\\codex\\cli.js'] });
});

/* 这就是 `node claude.exe` → ERR_UNKNOWN_FILE_EXTENSION 的现场。 */
test('一个包着 .exe 的 .cmd 垫片直接执行那个 exe，而不是拿 node 去加载它', () => {
  const { resolveCli } = loadResolver({
    'C:\\npm\\claude.cmd': '@echo off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
    'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe': 'MZ',
  });
  assert.deepEqual(resolveCli(['C:\\npm'], 'claude'),
    { file: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', args: [] });
});

/* %~dp0 展开时自带尾部反斜杠，加不加分隔符两种写法都有人生成。 */
test('%~dp0 后面没有分隔符的垫片同样认得出来', () => {
  const { resolveCli } = loadResolver({
    'C:\\tool\\bin\\thing.cmd': '@echo off\r\n"%~dp0thing.exe" %*\r\n',
    'C:\\tool\\bin\\thing.exe': 'MZ',
  });
  assert.deepEqual(resolveCli(['C:\\tool\\bin'], 'thing'), { file: 'C:\\tool\\bin\\thing.exe', args: [] });
});

test('解析不出来的 .cmd 要说「找到了但用不了」，不能说「没找到」', () => {
  const { resolveCli, requireCli } = loadResolver({ 'C:\\q\\qwen.cmd': '@echo off\r\nsomething entirely custom\r\n' });
  assert.deepEqual(resolveCli(['C:\\q'], 'qwen'), { unusable: 'C:\\q\\qwen.cmd' });
  const said: string[] = [];
  const error = console.error;
  console.error = (line: string) => { said.push(line); };
  try { assert.throws(() => requireCli(['C:\\q'], 'qwen'), /exit:127/); } finally { console.error = error; }
  assert.match(said[0], /found C:\\q\\qwen\.cmd/);
  assert.doesNotMatch(said[0], /command not found/);
});

test('真的没有才说 command not found', () => {
  const { resolveCli } = loadResolver({});
  assert.equal(resolveCli(['C:\\empty'], 'qwen'), undefined);
});

/* 非 Windows 不走垫片那套：找到可执行文件就直接用。 */
test('POSIX 上找到的可执行文件直接执行', () => {
  const { resolveCli } = loadResolver({ '/usr/local/bin\\qwen': '#!/bin/sh\n' }, 'darwin');
  assert.deepEqual(resolveCli(['/usr/local/bin'], 'qwen'), { file: '/usr/local/bin\\qwen', args: [] });
});

/* qwen 在 Windows 上就是这么装的：一个 .cmd 用绝对路径 call 另一个 .cmd。 */
test('跟着 call 链走到真正的垫片', () => {
  const { resolveCli } = loadResolver({
    'C:\\local\\qwen-code\\bin\\qwen.cmd':
      '@echo off\r\ncall "C:\\local\\qwen-code\\qwen-code\\bin\\qwen.cmd" %*\r\n',
    'C:\\local\\qwen-code\\qwen-code\\bin\\qwen.cmd':
      '@echo off\r\n"%~dp0\\..\\dist\\cli.js" %*\r\n',
    'C:\\local\\qwen-code\\qwen-code\\bin\\..\\dist\\cli.js': '// entry',
  });
  assert.deepEqual(resolveCli(['C:\\local\\qwen-code\\bin'], 'qwen'),
    { file: 'C:\\roost\\node.exe', args: ['C:\\local\\qwen-code\\qwen-code\\bin\\..\\dist\\cli.js'] });
});

/* 两个垫片互相指着对方，不能把启动器转死。 */
test('互相指向的垫片会在有限步内放弃', () => {
  const { resolveCli } = loadResolver({
    'C:\\a\\loop.cmd': '@echo off\r\ncall "C:\\b\\loop.cmd" %*\r\n',
    'C:\\b\\loop.cmd': '@echo off\r\ncall "C:\\a\\loop.cmd" %*\r\n',
  });
  assert.deepEqual(resolveCli(['C:\\a'], 'loop'), { unusable: 'C:\\a\\loop.cmd' });
});
