import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const json = async path => JSON.parse(await readFile(path, 'utf8'));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const exists = path => access(path).then(() => true, () => false);
export const portablePath = (path, separator = sep) => path.split(separator).join('/');
export async function write(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
