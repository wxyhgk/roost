// Controlled HTTP/WS faults around the real TermView/controller/query code.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import { PROTOCOL_VERSION } from '@roost/terminal-protocol';
type State = { reads: number; posts: unknown[]; live: boolean; rejected: boolean };
const states = new Map<string, State>();
function state(id: string) { let value = states.get(id); if (!value) { value = { reads: 0, posts: [], live: false, rejected: false }; states.set(id, value); } return value; }
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://localhost').pathname;
  const reply = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (path === '/api/test-stats') return reply(Object.fromEntries(states));
  const match = path.match(/^\/api\/sessions\/([^/]+)\/(resume|reopen)$/);
  if (match) {
    const [, id, action] = match, current = state(id);
    if (action === 'resume') {
      current.reads++;
      if (id === 'unconfirmed' || (id === 'conflict' && current.rejected)) return reply({ available: false, reason: 'identity_unconfirmed' });
      if (id === 'unavailable') return reply({ available: false, reason: 'source_unavailable' });
      if (id === 'syncing' && current.reads < 3) return reply({ available: false, reason: 'identity_syncing' });
      return reply({ available: true, cliId: 'opencode', cliName: 'OpenCode', nativeSessionId: 'ses_fixture', command: ['opencode', '-s', 'ses_fixture'] });
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); current.posts.push(input);
    if (id === 'conflict' && input.resume) { current.rejected = true; return reply({ error: { code: 'identity_unconfirmed', message: 'raw backend diagnostic' } }, 409); }
    current.live = true;
    return reply({ sessions: [], projects: [] });
  }
  if (path === '/api/cli-configs') return reply({ configs: [] });
  if (path === '/api/workspace') return reply({ sessions: [], projects: [], expandedProjectIds: [], pinnedSessionIds: [] });
  reply({}, 404);
});
const ws = new WebSocketServer({ server });
ws.on('connection', (socket, req) => {
  const id = new URL(req.url!, 'http://localhost').searchParams.get('id')!, current = state(id);
  socket.send(JSON.stringify(current.live
    ? { type: 'hello', pid: 12345, instanceId: 'fixture-' + id, protocol: PROTOCOL_VERSION, cwd: '/tmp', cli: 'opencode', cols: 80, rows: 24 }
    : { type: 'hello', pid: null, dead: true, cwd: '/tmp', cli: null }));
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'ready') socket.send(JSON.stringify({ type: 'replay', instanceId: 'fixture-' + id, seq: 0, data: 'Fixture terminal resumed successfully\r\n' }));
  });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const vite = await createViteServer({ root: resolve('frontend'), configFile: resolve('frontend/vite.config.ts'), server: {
  host: '127.0.0.1', port: 5177, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${port}`, ws: true } },
} });
await vite.listen(); console.log('http://127.0.0.1:5177/tests/browser/terminal-resume.html');
async function stop() { await vite.close(); for (const socket of ws.clients) socket.terminate(); ws.close(); server.closeAllConnections(); server.close(() => process.exit()); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
