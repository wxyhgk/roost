import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServerMonitorProcess, normalizeServices, type ServerMonitor } from '@roost/server-monitor';
import { readJson, sendError, HttpInputError } from './http';

export function createServerMonitorHandler(dataDir?: string, monitor: ServerMonitor = createServerMonitorProcess()) {
  const path = dataDir ? join(dataDir, 'monitored-services.json') : null;
  let loading: Promise<void> | undefined, writes = Promise.resolve();
  const load = () => loading ??= (async () => {
    if (!path) return;
    try { monitor.configure(normalizeServices(JSON.parse(await readFile(path, 'utf8')))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  })();
  const json = (res: ServerResponse, data: unknown) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (!['/api/server/status', '/api/server/summary', '/api/server/services'].includes(url.pathname)) return false;
      res.setHeader('cache-control', 'no-store');
      if (url.pathname === '/api/server/summary' && req.method === 'GET') {
        try { json(res, await monitor.summary()); }
        catch { sendError(res, 503, 'source_unavailable', 'Server metrics are temporarily unavailable'); }
        return true;
      }
      if (url.pathname === '/api/server/status' && req.method === 'GET') {
        try { await load(); json(res, await monitor.snapshot()); }
        catch { sendError(res, 503, 'source_unavailable', 'Server metrics are temporarily unavailable'); }
        return true;
      }
      if (url.pathname === '/api/server/services' && req.method === 'PUT') {
        const body = await readJson(req, 8192);
        let units: string[];
        try { units = normalizeServices(body.services); } catch { throw new HttpInputError(400, 'Use up to 24 valid systemd service names'); }
        const save = writes.catch(() => {}).then(async () => {
          await load();
          if (path && dataDir) {
            await mkdir(dataDir, { recursive: true, mode: 0o700 });
            const temporary = path + '.' + randomUUID();
            try { await writeFile(temporary, JSON.stringify(units) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
            finally { await rm(temporary, { force: true }); }
          }
          monitor.configure(units);
        });
        writes = save;
        try { await save; json(res, { services: units }); }
        catch { sendError(res, 503, 'storage_unavailable', 'Could not save monitored services'); }
        return true;
      }
      res.setHeader('allow', url.pathname.endsWith('/services') ? 'PUT' : 'GET');
      sendError(res, 405, 'method_not_allowed', 'Method not allowed');
      return true;
    },
    dispose() { monitor.dispose(); },
  };
}
