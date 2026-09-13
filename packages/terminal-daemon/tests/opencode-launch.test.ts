import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installOpenCodeLaunch, OPENCODE_TUI_OBSERVER_SCRIPT } from '../src/opencode-launch.ts';

const run = promisify(execFile);
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('observer condition timed out');
}

test('OpenCode launch uses additive TUI config and loopback port without probing a version', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-launch-')), bin = join(dir, 'bin'), real = join(dir, 'real');
  await mkdir(bin); await mkdir(real); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(real, 'opencode'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.TEST_OPENCODE_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({args:process.argv.slice(2),config:process.env.OPENCODE_TUI_CONFIG,endpoint:process.env.ROOST_OPENCODE_ENDPOINT}));\n`, { mode: 0o700 });
  await installOpenCodeLaunch(bin, dir);
  const env = { PATH: `${bin}:${real}:/usr/bin:/bin`, ROOST_OPENCODE_SOCKET: '/tmp/test.sock', TEST_OPENCODE_CALLS: join(dir, 'calls.jsonl') };
  const invoke = async (args: string[], extra = {}) => JSON.parse((await run(join(bin, 'opencode'), args, { env: { ...env, ...extra } })).stdout);
  const normal = await invoke(['--port', '41986', 'path with spaces']);
  assert.equal(normal.endpoint, 'http://127.0.0.1:41986');
  assert.deepEqual(normal.args, ['--hostname', '127.0.0.1', '--port', '41986', 'path with spaces']);
  const config = JSON.parse(await readFile(normal.config, 'utf8'));
  assert.deepEqual(Object.keys(config), ['plugin']); assert.match(config.plugin[0], /^file:/);
  const dynamic = await invoke([]); assert.match(dynamic.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const args of [['run', 'hello'], ['serve'], ['attach', 'http://localhost:1'], ['--pure'], ['--mini'], ['--hostname', '0.0.0.0'], ['--port', '70000']]) {
    const bypass = await invoke(args); assert.deepEqual(bypass.args, args); assert.equal(bypass.config, undefined);
  }
  const custom = await invoke([], { OPENCODE_TUI_CONFIG: '/tmp/existing.jsonc' });
  assert.equal(custom.config, '/tmp/existing.jsonc'); assert.equal(custom.endpoint, undefined);
  const calls = (await readFile(env.TEST_OPENCODE_CALLS, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.every(args => !args.includes('--version')), 'launch must not probe the CLI version');
});

for (const version of ['1.18.30', '2099.1.0-dev', undefined]) {
test(`OpenCode ${version} TUI route is authoritative, including switching sessions, going home and lifecycle disposal`, { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-observer-')), socketPath = join(dir, 'hook.sock');
  const events: any[] = [];
  const receiver = createServer(socket => { socket.write(JSON.stringify({ type: 'hello', version: 1 }) + '\n'); let buf = ''; socket.on('data', chunk => { buf += chunk; const i = buf.indexOf('\n'); if (i < 0) return;
    const m = JSON.parse(buf.slice(0, i)); assert.equal(m.method, 'opencodeEvent'); events.push(m.args[0]); socket.write('{"type":"rep'); setTimeout(() => socket.end('ly","requestId":"opencode-hook","result":true}\n'), 5);
  }); });
  await new Promise<void>(r => receiver.listen(socketPath, r));
  const patch = { ROOST_OPENCODE_SOCKET: socketPath, ROOST_OPENCODE_TERMINAL: 'web', ROOST_OPENCODE_INSTANCE: 'instance', ROOST_OPENCODE_TOKEN: 'test', ROOST_OPENCODE_ENDPOINT: 'http://127.0.0.1:41986' };
  const old = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]])); Object.assign(process.env, patch);
  let dispose = async () => {};
  t.after(async () => { await dispose(); for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise<void>(r => receiver.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const script = join(dir, 'observer.mjs'); await writeFile(script, OPENCODE_TUI_OBSERVER_SCRIPT);
  const observer = await import(pathToFileURL(script).href);
  assert.equal(observer.default.tui, observer.tui, 'OpenCode readV1Plugin loads the default object export');
  let route: any = { name: 'home' }, status = 'idle', permission = false;
  const sessions: Record<string, any> = { ses_a: { id: 'ses_a', directory: '/tmp/a' }, ses_b: { id: 'ses_b', directory: '/tmp/b' } };
  const api = { ...(version === undefined ? {} : { app: { version } }), route: { get current() { return route; } }, state: { session: {
    get: (id: string) => sessions[id], status: () => ({ type: status }), permission: () => permission ? [{}] : [], question: () => [],
  } }, lifecycle: { onDispose: (fn: typeof dispose) => { dispose = fn; } } };
  const incomplete = [null, { ...api, route: 'session' }, { ...api, route: {} }, { ...api, lifecycle: { onDispose: true } },
    ...['get', 'status', 'permission', 'question'].map(key => ({ ...api, state: { session: { ...api.state.session, [key]: undefined } } })),
  ];
  const initialDispose = dispose;
  for (const candidate of incomplete) await observer.tui(candidate);
  assert.equal(dispose, initialDispose, 'missing capabilities must not register an observer');
  assert.equal(events.length, 0);
  await observer.tui(api);
  await new Promise(r => setTimeout(r, 300)); assert.equal(events.length, 0, 'server sessions cannot establish the selected TUI identity');
  route = { name: 'session', params: { sessionID: 'ses_a' } }; await until(() => events.length === 2);
  assert.deepEqual(events.map(e => e.event), ['SessionStart', 'Stop']); assert.ok(events.every(e => e.sessionId === 'ses_a'));
  status = 'busy'; await until(() => events.at(-1)?.event === 'UserPromptSubmit');
  permission = true; await until(() => events.at(-1)?.event === 'PermissionRequest');
  permission = false; status = 'busy'; await until(() => events.at(-1)?.event === 'UserPromptSubmit');
  status = 'idle'; await until(() => events.at(-1)?.event === 'Stop');
  assert.deepEqual(events.slice(-2).map(e => [e.event, e.sessionId]), [['UserPromptSubmit', 'ses_a'], ['Stop', 'ses_a']]);
  const completedCount = events.length;
  await new Promise(r => setTimeout(r, 350)); assert.equal(events.length, completedCount, 'idle polling must not repeat completion');
  permission = false; status = 'idle'; route = { name: 'session', params: { sessionID: 'ses_b' } };
  await until(() => events.at(-1)?.sessionId === 'ses_b' && events.at(-1)?.event === 'Stop');
  assert.deepEqual(events.slice(-3).map(e => [e.event, e.sessionId]), [['SessionEnd', 'ses_a'], ['SessionStart', 'ses_b'], ['Stop', 'ses_b']]);
  assert.equal(new URL(events.at(-1).transcriptPath).searchParams.get('directory'), '/tmp/b');
  route = { name: 'home' }; await until(() => events.at(-1)?.event === 'SessionEnd');
  const count = events.length; status = 'busy'; await new Promise(r => setTimeout(r, 300)); assert.equal(events.length, count);
  assert.ok(events.every(e => e.terminalId === 'web' && e.instanceId === 'instance' && e.token === 'test' && e.protocolVersion === 1 && e.version === undefined));
});
}
