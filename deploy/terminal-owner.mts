// Foreground owner for systemd. Keep PTYs in a service separate from HTTP.
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonSocketPath, startTerminalOwner, writeRunningRecord } from '@roost/terminal-daemon';

const directory = process.env.ROOST_DATA_DIR ?? join(homedir(), '.roost');
await mkdir(directory, { recursive: true, mode: 0o700 });
const dataDir = await realpath(directory);
// 谁在跑哪一版：写失败不影响启动，理由见 packages/terminal-daemon/src/running-record.ts。
void writeRunningRecord({ dataDir, service: 'terminal', repoRoot: fileURLToPath(new URL('..', import.meta.url)) });
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
