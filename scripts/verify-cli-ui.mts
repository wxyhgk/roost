// Real SQLite + logo HTTP API and isolated Vite for UI acceptance; no daemon/PTY.
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as viteServer } from 'vite';
import { createWorkspaceStore } from '@roost/workspace-store';
import { handleCliConfigs, createCliIconStore } from '../backend/src/cli-configs';
const directory = await mkdtemp(join(tmpdir(), 'roost-cli-ui-'));
const store = createWorkspaceStore({ dataDir: directory });
const icons = createCliIconStore(join(directory, 'icons'));
const backend = httpServer((req, res) => {
  void handleCliConfigs(req, res, new URL(req.url!, 'http://localhost'), store, icons)
    .then(handled => { if (!handled) res.writeHead(404).end(); })
    .catch(() => res.writeHead(500).end('fixture error'));
});
backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
const port = (backend.address() as {port: number}).port;
const vite = await viteServer({ root: resolve('frontend'), configFile: resolve('frontend/vite.config.ts'),
  server: { port: 5191, host: '127.0.0.1', strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true, ws: false } } } });
await vite.listen();
console.log('CLI fixture: http://127.0.0.1:5191/tests/browser/cli-settings.html');
let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  await vite.close(); backend.closeAllConnections();
  await new Promise<void>(resolve => backend.close(() => resolve()));
  store.close(); await rm(directory, {recursive:true,force:true});
};
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
