import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { sanitizeSvgIcon } from './svg-icon';
import { DEFAULT_CLI_DEFINITIONS, getCliAdapter, type CliDefinition, type CliRule } from '@roost/cli-adapters';
import type { WorkspaceStore } from '@roost/workspace-store';
import { readJson, HttpInputError, sendError, type ApiErrorCode } from './http';

const MAX_ICON = 1024 * 1024;
const iconPattern = /^[a-f0-9]{64}\.(?:png|svg)$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
class ConfigError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(message: string): never { throw new ConfigError(400, message); }
function present(def: CliDefinition) {
  return { ...def, iconUrl: def.iconRef ? `/api/cli-icons/${encodeURIComponent(def.iconRef)}` : null,
    capabilities: { text: true, image: def.builtin && getCliAdapter(def.id) !== null } };
}
export function createCliIconStore(directory: string) {
  return {
    async exists(ref: string) { if (!iconPattern.test(ref)) return false; try { await readFile(join(directory, ref)); return true; } catch { return false; } },
    async read(ref: string) { return iconPattern.test(ref) ? readFile(join(directory, ref)).catch(() => null) : null; },
    async save(bytes: Buffer, contentType = 'image/png') {
      let output: Buffer;
      let extension = 'png';
      try {
        const svg = contentType.split(';')[0].trim().toLowerCase() === 'image/svg+xml';
        const sanitized = svg ? sanitizeSvgIcon(bytes) : bytes;
        const input = sharp(sanitized, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
        const metadata = await input.metadata();
        if (!(svg ? ['svg'] : ['png', 'jpeg', 'webp']).includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('format');
        const rendered = await input.rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
        output = svg ? sanitized : rendered;
        extension = svg ? 'svg' : 'png';
      } catch { throw new ConfigError(415, 'Logo must be a valid static SVG, PNG, JPEG or WebP image'); }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const ref = `${createHash('sha256').update(output).digest('hex')}.${extension}`;
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try { await writeFile(temporary, output, { flag: 'wx', mode: 0o600 }); await rename(temporary, join(directory, ref)); }
      finally { await rm(temporary, { force: true }); }
      return ref;
    },
  };
}
export type CliIconStore = ReturnType<typeof createCliIconStore>;
async function readIcon(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0; let finished = false; const chunks: Buffer[] = [];
    const timer = setTimeout(() => { finished = true; chunks.length = 0; reject(new ConfigError(408, 'Upload timed out')); req.resume(); }, 30_000);
    timer.unref();
    const done = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); if (error) reject(error); else resolve(Buffer.concat(chunks)); };
    req.on('data', (chunk: Buffer) => { if (finished) return; size += chunk.length; if (size > MAX_ICON) { chunks.length = 0; done(new ConfigError(413, 'Logo exceeds 1 MiB')); } else chunks.push(chunk); });
    req.on('end', () => done()); req.on('error', done); req.on('aborted', () => done(new ConfigError(400, 'Upload aborted')));
  });
}
async function patchFields(body: Record<string, unknown>, icons?: CliIconStore) {
  const patch: Partial<CliDefinition> = {};
  for (const key of Object.keys(body)) if (!['id', 'name', 'command', 'rules', 'iconRef', 'enabled', 'priority'].includes(key)) fail(`Unknown field: ${key}`);
  for (const key of ['name', 'command'] as const) if (key in body) {
    const value = body[key];
    if (typeof value !== 'string' || !value.trim() || value.length > (key === 'name' ? 128 : 4096) || /[\x00-\x1f]/.test(value)) fail(`Invalid ${key}`);
    patch[key] = value;
  }
  if ('enabled' in body) { if (typeof body.enabled !== 'boolean') fail('enabled must be boolean'); patch.enabled = body.enabled; }
  if ('priority' in body) { if (!Number.isInteger(body.priority) || Math.abs(body.priority as number) > 1000) fail('priority must be an integer between -1000 and 1000'); patch.priority = body.priority as number; }
  if ('rules' in body) {
    if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 32) fail('rules must contain 1–32 recognition rules');
    patch.rules = body.rules.map((rule: unknown): CliRule => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('Invalid recognition rule');
      const { kind, value } = rule as Record<string, unknown>;
      if (!['executable', 'script', 'executablePathContains'].includes(String(kind)) || typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value)) fail('Invalid recognition rule');
      if (kind === 'executable' && /[\\/\s]/.test(value)) fail('executable must be a basename');
      if (kind === 'executablePathContains' && !value.includes('/')) fail('executablePathContains must contain a path segment');
      return { kind: kind as CliRule['kind'], value };
    });
  }
  if ('iconRef' in body) {
    const ref = body.iconRef;
    if (ref !== null && (typeof ref !== 'string' || !(DEFAULT_CLI_DEFINITIONS.some(d => d.iconRef === ref) || await icons?.exists(ref)))) fail('Unknown iconRef');
    patch.iconRef = ref as string | null;
  }
  return patch;
}
export async function handleCliConfigs(req: IncomingMessage, res: ServerResponse, url: URL, store: WorkspaceStore, icons?: CliIconStore) {
  const match = url.pathname.match(/^\/api\/cli-configs(?:\/([^/]+)(?:\/(reset|icon))?)?$/);
  const icon = url.pathname.match(/^\/api\/cli-icons\/([^/]+)$/);
  if (!match && !icon) return false;
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (icon && req.method === 'GET') {
      const ref = decodeURIComponent(icon[1]);
      if (DEFAULT_CLI_DEFINITIONS.some(d => d.iconRef === ref)) {
        const bytes = await readFile(new URL(`../assets/cli-icons/${ref.slice(8)}.svg`, import.meta.url));
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' }); res.end(bytes);
      } else {
        const bytes = await icons?.read(ref);
        if (!bytes) throw new ConfigError(404, 'Icon not found');
        res.writeHead(200, { 'content-type': ref.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'none'; sandbox", 'cache-control': 'public, max-age=31536000, immutable' }); res.end(bytes);
      }
      return true;
    }
    if (!match) throw new ConfigError(405, 'Method not allowed');
    const id = match[1] ? decodeURIComponent(match[1]) : undefined;
    if (id && !idPattern.test(id)) fail('Invalid CLI id');
    const action = match[2];
    if (!id) {
      if (req.method === 'GET') send(200, { configs: store.cliConfigs.list().map(present) });
      else if (req.method === 'POST') {
        const body = await readJson(req, 64 * 1024);
        const newId = body.id ?? `cli_${randomUUID()}`;
        if (typeof newId !== 'string' || !idPattern.test(newId)) fail('Invalid CLI id');
        const patch = await patchFields(body, icons);
        if (!patch.name || !patch.command || !patch.rules) fail('name, command and rules are required');
        const def = store.cliConfigs.create({ id: newId, name: patch.name, command: patch.command, rules: patch.rules, iconRef: null, enabled: true, priority: 0, ...patch, builtin: false });
        if (!def) throw new ConfigError(409, 'CLI id already exists');
        send(201, present(def));
      } else throw new ConfigError(405, 'Method not allowed');
    } else {
      const current = store.cliConfigs.get(id);
      if (!current) throw new ConfigError(404, 'CLI not found');
      if (action === 'icon' && req.method === 'POST') {
        if (!icons) throw new ConfigError(503, 'Icon storage unavailable');
        if (!/^image\/(png|jpeg|webp|svg\+xml)(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new ConfigError(415, 'Send the image as a raw SVG, PNG, JPEG or WebP request body');
        const ref = await icons.save(await readIcon(req), req.headers['content-type']);
        const updated = store.cliConfigs.update(id, { iconRef: ref });
        if (!updated) throw new ConfigError(404, 'CLI not found');
        send(200, present(updated));
      } else if (action === 'reset' && req.method === 'POST') {
        if (!current.builtin) fail('Only built-in CLIs have defaults');
        send(200, present(store.cliConfigs.reset(id)!));
      } else if (!action && req.method === 'GET') send(200, present(current));
      else if (!action && req.method === 'PATCH') {
        const body = await readJson(req, 64 * 1024);
        if ('id' in body) fail('CLI id cannot be changed');
        const updated = store.cliConfigs.update(id, await patchFields(body, icons));
        if (!updated) throw new ConfigError(404, 'CLI not found');
        send(200, present(updated));
      } else if (!action && req.method === 'DELETE') { store.cliConfigs.remove(id); res.writeHead(204); res.end(); }
      else throw new ConfigError(405, 'Method not allowed');
    }
  } catch (error) {
    if (error instanceof URIError) sendError(res, 400, 'invalid_request', 'Invalid URL encoding');
    else if (error instanceof ConfigError || error instanceof HttpInputError) {
      const codes: Record<number, ApiErrorCode> = {
        400: 'invalid_request', 404: 'not_found', 405: 'method_not_allowed',
        408: 'request_timeout', 409: 'conflict', 413: 'too_large',
        415: 'unsupported_media_type', 503: 'storage_unavailable',
      };
      sendError(res, error.status, codes[error.status] ?? 'internal_error', error.message);
    } else {
      console.error('CLI configuration operation failed', error);
      sendError(res, 500, 'internal_error', 'CLI configuration operation failed');
    }
  }
  return true;
}
