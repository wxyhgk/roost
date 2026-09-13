import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { providerIds, type ProviderId } from '@roost/subscriptions';
import { HttpInputError, readJson, sendError } from '../http';
import { UsageError } from './common';
import { createSubscriptions, type Subscriptions } from './service';
export function createSubscriptionsHandler(dataDir?: string, service: Subscriptions = createSubscriptions({ directory: dataDir ? join(dataDir, 'subscriptions') : undefined })) {
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (!url.pathname.startsWith('/api/subscriptions/')) return false;
      res.setHeader('cache-control', 'no-store');
      const match = url.pathname.match(/^\/api\/subscriptions\/([^/]+)(?:\/(refresh|connect|key))?$/);
      if (!match || !providerIds.includes(match[1] as ProviderId)) { sendError(res, 404, 'not_found', 'Subscription provider not found'); return true; }
      const provider = match[1] as ProviderId, action = match[2];
      const allowed = !action ? 'GET' : action === 'refresh' ? 'POST' : action === 'connect' && provider === 'claude' ? 'POST' : action === 'key' && provider === 'opencode-go' ? 'PUT, DELETE' : '';
      if (!allowed.split(', ').includes(req.method || '')) { res.setHeader('allow', allowed || 'GET'); sendError(res, 405, 'method_not_allowed', 'Method not allowed'); return true; }
      try {
        if (action === 'connect') await service.configure(provider);
        if (action === 'key') {
          const body = req.method === 'PUT' ? await readJson(req, 8192) : null;
          if (body && (typeof body.key !== 'string' || !body.key.trim() || body.key.length > 4096 || /\s/.test(body.key.trim()))) throw new HttpInputError(400, 'Invalid API key');
          await service.configure(provider, body ? String(body.key).trim() : null);
        }
        const snapshot = await service.read(provider, !!action);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(snapshot));
      } catch (error) {
        if (error instanceof HttpInputError) throw error;
        sendError(res, 503, 'source_unavailable', error instanceof UsageError ? error.issue : 'Subscription source unavailable');
      }
      return true;
    },
    dispose() { service.dispose(); },
  };
}
