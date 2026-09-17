/*
  Codex 垫片的判断逻辑。

  启动脚本是**内联成文本**写进临时目录的，没有模块边界可以 import。所以照仓库里既有的
  办法（见 cli-launch-tools.test.ts）：把导出的那段文本实例化成函数、注入桩，测到的就是
  真正会被写出去的那份代码。

  这里钉的是「什么时候接管、什么时候放手」——接错了会去抢用户自己的 app-server，
  放错了会让恢复出来的会话全都没有状态。
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_LAUNCH_SCRIPT } from '../src/codex-launch.ts';

type Spawned = { args: string[]; env: Record<string, string | undefined> };

/** 把 ESM 的壳剥掉（import 行 + 末尾的 main()），其余原样跑。 */
function instantiate(env: Record<string, string | undefined>, argv: string[]) {
  const body = CODEX_LAUNCH_SCRIPT
    .split('\n').filter(line => !line.startsWith('import ')).join('\n')
    .replace(/\nmain\(\);\s*$/, '\n')
    .replace('__BIN__', JSON.stringify('/fake/roost-bin'));
  const spawned: Spawned[] = [];
  const factory = new Function(
    'spawn', 'spawnSync', 'accessSync', 'constants', 'realpathSync', 'existsSync', 'rmSync',
    'readFileSync', 'mkdirSync', 'delimiter', 'dirname', 'join', 'resolve', 'createConnection',
    'randomBytes', 'process',
    `${body}\nreturn { observe, tui, version, supportedVersion, run: main };`,
  );
  const api = factory(
    (file: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      spawned.push({ args: [file, ...args], env: options?.env ?? {} });
      return { on() {}, kill() {} };
    },
    () => ({ stdout: '0.154.0\n' }),
    () => {}, {}, (p: string) => p, () => true, () => {}, () => '', () => {},
    ':', (p: string) => p, (...parts: string[]) => parts.join('/'), (p: string) => p,
    () => ({ on() {}, write() {}, destroy() {} }),
    () => ({ toString: () => 'abcdef123456' }),
    { ...process, env, argv: ['node', 'codex-launch.mjs', ...argv], on() {}, exit() {} },
  ) as { observe: boolean; tui: boolean; version: string; supportedVersion(text: string): boolean; run(): Promise<void> };
  return { ...api, spawned };
}

const ENV = {
  PATH: '/fake/path',
  ROOST_CODEX_SOCKET: '/tmp/daemon.sock',
  ROOST_CODEX_TOKEN: 'a'.repeat(64),
  ROOST_CODEX_TERMINAL: 'term',
  ROOST_CODEX_INSTANCE: 'inst',
  ROOST_CODEX_RUNTIME: '/private/tmp/roost-codex-501',
};

test('裸 TUI 和 resume 都接管，其余子命令放手', () => {
  assert.equal(instantiate(ENV, []).observe, true, '裸 codex 就是 TUI');
  // roost 恢复 codex 会话用的正是 `codex resume <id>`——排除它等于恢复出来的会话全都没状态。
  assert.equal(instantiate(ENV, ['resume', 'abc']).observe, true);
  for (const sub of ['exec', 'app-server', 'login', 'mcp', 'agents', 'doctor', 'cloud']) {
    assert.equal(instantiate(ENV, [sub]).observe, false, `${sub} 不该被接管`);
  }
});

test('用户自己带了 --remote 就不抢', () => {
  assert.equal(instantiate(ENV, ['--remote', 'unix:///his/own.sock']).observe, false);
  assert.equal(instantiate(ENV, ['--remote-auth-token-env', 'TOKEN']).observe, false);
});

test('--help / --version 走原样', () => {
  for (const flag of ['--help', '-h', '--version', '-v']) {
    assert.equal(instantiate(ENV, [flag]).observe, false, `${flag} 不该被接管`);
  }
});

test('缺任何一个环境变量都不接管——没有守护进程可报就没有意义', () => {
  for (const key of ['ROOST_CODEX_SOCKET', 'ROOST_CODEX_TOKEN', 'ROOST_CODEX_RUNTIME']) {
    assert.equal(instantiate({ ...ENV, [key]: undefined }, []).observe, false, `少了 ${key}`);
  }
  // 自己起的 app-server 会带上这个，防止无限套娃。
  assert.equal(instantiate({ ...ENV, ROOST_CODEX_OBSERVING: '1' }, []).observe, false);
});

test('版本比较按数值，不按字符串', () => {
  const { supportedVersion } = instantiate(ENV, []);
  assert.equal(supportedVersion('0.154.0'), true);
  assert.equal(supportedVersion('0.200.1'), true);
  assert.equal(supportedVersion('1.0.0'), true, '将来的大版本不该被挡在外面');
  assert.equal(supportedVersion('0.153.9'), false);
  // 字符串比较里 '0.99' > '0.154'，而它其实更旧——这条就是为了钉住这个陷阱。
  assert.equal(supportedVersion('0.99.0'), false);
  assert.equal(supportedVersion(''), false);
  assert.equal(supportedVersion('坏的'), false);
});
