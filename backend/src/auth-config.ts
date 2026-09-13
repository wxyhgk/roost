import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AuthOptions } from './auth';

/** Bootstrap stays on the local filesystem. Never print the password or expose it over HTTP. */
export async function loadAuthentication(dataDir: string): Promise<AuthOptions> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'auth-password');
  try {
    const created = await open(path, 'wx', 0o600);
    try { await created.writeFile(randomBytes(32).toString('base64url') + '\n'); await created.sync(); }
    finally { await created.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid()))
      throw new Error('auth-password must be an owned regular file with mode 0600');
    const password = (await handle.readFile('utf8')).replace(/\r?\n$/, '');
    if (Array.from(password).length < 6) throw new Error('auth-password must contain at least 6 characters');
    return { password, secureCookie: process.env.ROOST_AUTH_INSECURE_HTTP !== '1', savePassword: async next => {
      if (Array.from(next).length < 6 || next.length > 1024 || /[\r\n\0]/.test(next)) throw new Error('invalid new password');
      // A new inode prevents partial writes; retain the original on any error
      // before rename. Never follow a replaced password file or weaken its mode.
      const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await current.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
          throw new Error('auth-password must be an owned regular file with mode 0600');
      } finally { await current.close(); }
      const temporary = join(dataDir, '.auth-password-' + randomUUID());
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(next + '\n'); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
    } };
  } finally { await handle.close(); }
}
