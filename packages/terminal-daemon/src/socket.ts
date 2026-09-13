import { createHash } from 'node:crypto';
export function daemonSocketPath(dataDir:string) {
  return `/tmp/diy-pty-${process.getuid?.()??'user'}-${createHash('sha256').update(dataDir).digest('hex').slice(0,20)}.sock`;
}
