import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
export function daemonSocketPath(dataDir:string, platform = process.platform) {
  if (platform === 'win32') return '\\\\.\\pipe\\roost-pty-' + createHash('sha256').update(homedir().toLowerCase() + '\0' + dataDir.toLowerCase().replaceAll('\\', '/')).digest('hex').slice(0, 32);
  return `/tmp/diy-pty-${process.getuid?.()??'user'}-${createHash('sha256').update(dataDir).digest('hex').slice(0,20)}.sock`;
}
