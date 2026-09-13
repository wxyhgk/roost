// Optional manual smoke: node --import tsx frontend/tests/browser/terminal-local-echo-live.mts
// An isolated OpenCode with 150ms latency in each direction. No model requests
// are made by the harness. Close the test page or stop this process to clean up.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
const executable = execFileSync('/usr/bin/which', ['opencode'], { encoding: 'utf8' }).trim();
const server = createServer();
const sockets = new WebSocketServer({ server });
const cleanup = new Set<() => Promise<void>>();
sockets.on('connection', async (socket, request) => {
  if (request.headers.origin !== 'http://127.0.0.1:5173') { socket.close(); return; }
  const dir = await mkdtemp(join(tmpdir(), 'roost-echo-live-'));
  const child = pty.spawn(executable, [], { cwd: dir, cols: 80, rows: 20, name: 'xterm-256color', env: {
    HOME: dir, PATH: process.env.PATH!, TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
    XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'),
    XDG_STATE_HOME: join(dir, 'state'), XDG_CACHE_HOME: join(dir, 'cache'), OPENCODE_DISABLE_MODELS_FETCH: 'true',
  } });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void) => { const timer = setTimeout(() => { timers.delete(timer); if (socket.readyState === socket.OPEN) fn(); }, 150); timers.add(timer); };
  const data = child.onData(text => later(() => socket.send(text)));
  const exited = new Promise<void>(resolve => child.onExit(() => resolve()));
  socket.on('message', chunk => { const text = String(chunk); if (text.length <= 65536) later(() => child.write(text)); });
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true; cleanup.delete(stop);
    for (const timer of timers) clearTimeout(timer); data.dispose();
    try { child.kill(); } catch { /* already exited */ }
    socket.close();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  cleanup.add(stop); socket.on('close', () => void stop());
  child.onExit(() => void stop());
});
server.listen(8791, '127.0.0.1', () => console.log('Isolated OpenCode latency fixture listening on 127.0.0.1:8791'));
async function stop() { await Promise.all([...cleanup].map(fn => fn())); sockets.close(); server.close(); }
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
