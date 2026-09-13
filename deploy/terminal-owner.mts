// Foreground owner for systemd. Keep PTYs in a service separate from HTTP.
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { daemonSocketPath, startTerminalOwner } from '@roost/terminal-daemon';

const directory = process.env.ROOST_DATA_DIR ?? join(homedir(), '.roost');
await mkdir(directory, { recursive: true, mode: 0o700 });
const dataDir = await realpath(directory);
const owner = await startTerminalOwner({
  socketPath: daemonSocketPath(dataDir), dataDir,
  shell: process.env.SHELL ?? '/bin/bash', defaultCwd: homedir(),
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void owner.stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
