// Drive the installed WebView2 application with its matching Microsoft Edge WebDriver.
// No test server, Tauri plugin or automation API is compiled into the application.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, readdir, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function matchingDriver(temporary) {
  // The runner's Edge browser and WebView2 Runtime may be years apart in version.
  // Inspect the installed WebView2, then download its matching official driver.
  const candidates = [];
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)) {
    const root = join(base, 'Microsoft/EdgeWebView/Application');
    for (const version of await readdir(root).catch(() => [])) {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) continue;
      const folder = join(root, version);
      if (await access(join(folder, 'msedgewebview2.exe')).then(() => true, () => false)) candidates.push({ version, folder });
    }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const runtime = candidates[0];
  if (!runtime) throw Error('No installed WebView2 Runtime found');
  const response = await fetch(`https://msedgedriver.microsoft.com/${runtime.version}/edgedriver_win64.zip`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error('Matching Edge WebDriver download failed: ' + response.status);
  const archive = join(temporary, 'edgedriver.zip');
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  execFileSync(join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', archive, '-C', temporary, 'msedgedriver.exe']);
  const executable = join(temporary, 'msedgedriver.exe');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' });
  assert.ok(version.includes(runtime.version.split('.').slice(0, 3).join('.') + '.'));
  return { executable, folder: runtime.folder };
}

export async function testWindowsUi(installed) {
  const temporary = await mkdtemp(join(tmpdir(), 'roost-webview-'));
  const data = join(temporary, 'workspace');
  await mkdir(data);
  const port = await new Promise((resolve, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const matched = await matchingDriver(temporary);
  const driver = spawn(matched.executable, ['--port=' + port, '--host=127.0.0.1'], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: 'true', ROOST_DESKTOP_DATA_DIR: data,
      WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: matched.folder },
  });
  let launchError, session;
  driver.on('error', error => { launchError = error; });
  const base = `http://127.0.0.1:${port}`;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function request(method, path, body) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000) });
    const result = await response.json();
    // Successful execute responses may contain any application value, including an
    // `error` property. WebDriver protocol errors use a non-success HTTP status.
    if (!response.ok) throw Error('WebView2 check: ' + (result.value?.message ?? response.status));
    return result.value;
  }
  async function until(read, timeout = 75000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      const value = await read(); if (value) return value;
      await sleep(250);
    }
    throw Error('Installed WebView2 application did not become ready');
  }
  try {
    await until(() => request('GET', '/status').catch(() => false), 10000);
    session = (await request('POST', '/session', { capabilities: { alwaysMatch: {
      browserName: 'webview2', 'ms:edgeChromium': true, 'ms:edgeOptions': { binary: join(installed, 'roost-desktop.exe') },
    } } })).sessionId;
    const endpoint = '/session/' + session;
    async function workspace() {
      await until(async () => {
        const state = await request('POST', endpoint + '/execute/sync', { script: `return {
          origin: location.origin,
          mounted: !!document.querySelector('button[aria-label="New"], button[aria-label="新建"]'),
          password: !!document.querySelector('input[type="password"]'),
          bootstrapStatus: document.querySelector('#status')?.textContent
        }`, args: [] });
        if (/未能启动/.test(state.bootstrapStatus ?? '')) throw Error(state.bootstrapStatus);
        return /^http:\/\/127\.0\.0\.1:\d+$/.test(state.origin) && state.mounted && !state.password;
      });
      const auth = await request('POST', endpoint + '/execute/async', {
        script: `const done = arguments[arguments.length - 1];
          fetch('/api/auth/session').then(r => r.json()).then(v => done({authenticated:v.authenticated,canChangePassword:v.canChangePassword})).catch(() => done({authenticated:false}));`, args: [],
      });
      assert.deepEqual(auth, { authenticated: true, canChangePassword: false });
    }
    await workspace();
    const elementId = value => value['element-6066-11e4-a52e-4f735466cecf'];
    const button = await request('POST', endpoint + '/element', { using: 'css selector', value: 'button[aria-label="New"], button[aria-label="新建"]' });
    await request('POST', endpoint + '/element/' + elementId(button) + '/click', {});
    const terminal = await request('POST', endpoint + '/element', { using: 'css selector', value: '[role="menuitem"]' });
    const label = await request('GET', endpoint + '/element/' + elementId(terminal) + '/text');
    assert.ok(['Terminal', '终端'].includes(label));
    await request('POST', endpoint + '/element/' + elementId(terminal) + '/click', {});
    async function terminalCreated() {
      return request('POST', endpoint + '/execute/async', {
        script: `const done = arguments[arguments.length - 1]; fetch('/api/workspace').then(r => r.json()).then(v => done(v.sessions?.length === 1)).catch(() => done(false));`, args: [],
      });
    }
    await until(terminalCreated);
    await request('POST', endpoint + '/refresh', {});
    await workspace();
    assert.equal(await terminalCreated(), true);
    console.log('Installed Windows WebView2: native startup, passwordless workspace, New terminal and refresh passed');
  } finally {
    if (session) await request('DELETE', '/session/' + session).catch(() => {});
    driver.kill();
    const source = fileURLToPath(new URL('../src-tauri/resources/runtime/packages/terminal-daemon/src/index.js', import.meta.url));
    const { connectTerminalDaemon, daemonSocketPath } = await import(pathToFileURL(source));
    const owner = await connectTerminalDaemon(daemonSocketPath(await realpath(data))).catch(() => null);
    if (owner) {
      const pid = owner.ownerPid;
      for (const item of owner.listSessions()) await owner.killSession(item.id);
      owner.dispose(); try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    await sleep(500);
    await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
