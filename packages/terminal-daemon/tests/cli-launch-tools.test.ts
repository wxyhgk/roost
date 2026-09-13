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
