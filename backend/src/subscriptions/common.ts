import { open, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SubscriptionIssue, SubscriptionState } from '@roost/subscriptions';
export class UsageError extends Error {
  constructor(public issue: Exclude<SubscriptionIssue, null>, public state: SubscriptionState = 'unavailable', public retryMs?: number) { super(issue); }
}
export const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
export async function readSmall(path: string, limit = 262144): Promise<string> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new UsageError('invalid_response');
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > limit) throw new UsageError('invalid_response');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await file.close(); }
}
export async function atomicPrivate(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const cleanText = (value: unknown, max = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : null;
export const percent = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e6 ? value : null;
export function date(value: unknown, seconds = false): string | null {
  if ((seconds && (typeof value !== 'number' || !Number.isFinite(value))) || (!seconds && typeof value !== 'string')) return null;
  const parsed = new Date(seconds ? (value as number) * 1000 : value as string);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() > 0 ? parsed.toISOString() : null;
}
