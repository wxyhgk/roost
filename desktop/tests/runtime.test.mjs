import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, cp, rm, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { resolveTarget, assertBuildable } from '../scripts/lib/targets.mjs';

const bundle = process.env.ROOST_DESKTOP_BUNDLE;
const windows = process.platform === 'win32';
const target = resolveTarget();
assertBuildable(target);
const source = bundle ? join(bundle, windows ? 'runtime' : 'Contents/Resources/runtime') : fileURLToPath(new URL('../src-tauri/resources/runtime/', import.meta.url));
const binary = bundle ? join(bundle, windows ? 'roost-node.exe' : 'Contents/MacOS/roost-node') : fileURLToPath(new URL('../src-tauri/binaries/' + target.sidecar, import.meta.url));
const cleanEnv = windows ? {
  HOME: homedir(), USERPROFILE: homedir(), SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, TEMP: tmpdir(), TMP: tmpdir(),
  PATH: join(process.env.SystemRoot, 'System32') + ';' + join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0'),
} : { HOME: homedir(), PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = read(); if (value) return value; await sleep(20); }
  throw Error('Timed out waiting for desktop runtime');
}

test('relocated production runtime authenticates, serves assets and preserves a real PTY across HTTP restarts', { timeout: 120000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'roost-desktop-'));
  const runtime = join(temp, '应用 runtime'), data = join(temp, 'workspace');
  const children = [], sockets = [];
  let owner;
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end(); await waitFor(() => child.exitCode !== null || child.signalCode !== null).catch(() => child.kill());
      }
    }
    if (owner) {
      const pid = owner.ownerPid;
      for (const session of owner.listSessions()) await owner.killSession(session.id).catch(() => {});
      owner.dispose(); try { process.kill(pid, 'SIGTERM'); } catch {} await sleep(windows ? 1000 : 300);
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  await cp(source, runtime, { recursive: true });
  const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'));
  assert.equal(manifest.target, target.triple);
  assert.equal(manifest.nodeExecutable, target.nodeExecutable);
  assert.ok(Object.keys(manifest.files).includes('desktop/runtime/server.mjs'));
  assert.ok(!Object.keys(manifest.files).includes('desktop/src/server.mjs'));
  await mkdir(join(runtime, 'bin')); await cp(binary, join(runtime, 'bin', target.nodeExecutable));
  await mkdir(data);
  const node = join(runtime, 'bin', target.nodeExecutable);
  // Exercise the packaged native modules with the bundled LTS Node, not Homebrew Node.
  const native = execFileSync(node, ['--input-type=module', '-e', "import sharp from 'sharp';import pty from 'node-pty';console.log(typeof pty.spawn, (await sharp({create:{width:2,height:2,channels:4,background:'#fff'}}).png().toBuffer()).length>0)"],
    { cwd: runtime, env: cleanEnv, encoding: 'utf8' });
  assert.match(native, /function true/);
  async function launch() {
    const child = spawn(node, [join(runtime, 'desktop/runtime/server.mjs')], {
      cwd: temp, env: cleanEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
    const lines = createInterface({ input: child.stdout });
    child.stdin.write(JSON.stringify({ type: 'start', dataDir: data }) + '\n');
    const ready = await Promise.race([
      once(lines, 'line').then(([line]) => JSON.parse(line)),
      once(child, 'exit').then(() => { throw Error('Runtime exited before readiness: ' + errors); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Readiness timeout: ' + errors)), 35000); timer.unref(); }),
    ]);
    assert.equal(ready.pid, child.pid);
    return { child, ...ready, cookie: ready.cookie.split(';')[0], errors: () => errors };
  }
  let app = await launch();
  const { connectTerminalDaemon, daemonSocketPath } = await import(pathToFileURL(join(runtime, 'packages/terminal-daemon/src/index.js')));
  owner = await connectTerminalDaemon(daemonSocketPath(await realpath(data)));
  const request = (path, options = {}) => fetch(app.url + path, { ...options,
    headers: { origin: app.url, cookie: app.cookie, 'content-type': 'application/json', ...options.headers } });
  assert.equal((await fetch(app.url + '/api/workspace')).status, 401);
  await assert.rejects(readFile(join(data, 'auth-password')), { code: 'ENOENT' });
  const state = await (await request('/api/auth/session')).json();
  assert.equal(state.authenticated, true); assert.equal(state.canChangePassword, false);
  for (const endpoint of ['login', 'password', 'logout'])
    assert.equal((await request('/api/auth/' + endpoint, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await request('/api/workspace', { headers: { origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(app.url + '/package.json')).status, 404);
  assert.equal((await fetch(app.url + '/../manifest.json')).status, 404);
  const html = await fetch(app.url + '/'); assert.equal(html.status, 200);
  const page = await html.text();
  assert.ok(page.includes('name="roost-runtime" content="desktop"'));
  assert.ok(!page.includes('@vite/client'));
  const asset = page.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(app.url + asset)).status, 200);
  assert.equal((await request('/api/server/summary')).status, 200, app.errors());
  const created = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd: data, title: 'Desktop smoke' }) });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  async function terminal() {
    const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/api/pty?id=' + id, { origin: app.url, headers: { cookie: app.cookie } });
    sockets.push(ws); const messages = []; ws.on('error', () => {});
    ws.on('message', bytes => messages.push(JSON.parse(bytes)));
    const hello = await waitFor(() => messages.find(m => m.type === 'hello'));
    ws.send(JSON.stringify({ type: 'ready', protocol: 2, cols: 80, rows: 24 }));
    await waitFor(() => messages.find(m => m.type === 'replay'));
    return { ws, messages, hello };
  }
  let client = await terminal();
  const identity = client.hello;
  client.ws.send(JSON.stringify({ type: 'input', data: windows ? "Write-Output ('roost' + '桌面验证')\r" : "printf '\\162\\157\\157\\163\\164桌面验证\\n'\n" }));
  await waitFor(() => client.messages.filter(m => m.type === 'output').map(m => m.data).join('').includes('roost桌面验证'))
    .catch(error => { throw Error(error.message + ': ' + JSON.stringify(client.messages)); });
  // macOS file monitoring uses its compiled child-process entry too.
  const watcher = new WebSocket(app.url.replace('http:', 'ws:') + '/api/files/watch?root=' + encodeURIComponent(data), { origin: app.url, headers: { cookie: app.cookie } });
  sockets.push(watcher); watcher.on('error', () => {});
  const changes = []; watcher.on('message', bytes => changes.push(JSON.parse(bytes)));
  await once(watcher, 'open'); await sleep(400);
  await writeFile(join(data, 'watch-test.txt'), 'desktop');
  await waitFor(() => changes.some(m => m.type === 'files-changed'));
  const ended = once(app.child, 'exit'); app.child.stdin.write('shutdown\n'); await ended;
  process.kill(identity.pid, 0);
  const oldCookie = app.cookie;
  app = await launch();
  assert.equal((await request('/api/workspace', { headers: { cookie: oldCookie } })).status, 401);
  client = await terminal();
  assert.equal(client.hello.pid, identity.pid);
  assert.equal(client.hello.instanceId, identity.instanceId);
  assert.ok(client.messages.some(m => m.type === 'replay' && m.data.includes('roost桌面验证')));
  client.ws.send(JSON.stringify({ type: 'input', data: windows ? "Write-Output ('roost-' + 'after-reopen')\r" : "printf '\\162\\157\\157\\163\\164-after-reopen\\n'\n" }));
  await waitFor(() => client.messages.find(m => m.type === 'output' && m.data.includes('roost-after-reopen')));
  assert.equal((await request(`/api/sessions/${id}/kill`, { method: 'POST' })).status, 200);
});
