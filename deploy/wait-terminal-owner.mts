import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { connectTerminalDaemon, daemonSocketPath } from '@roost/terminal-daemon';

const dataDir = await realpath(process.env.ROOST_DATA_DIR ?? join(homedir(), '.roost'));
for (let attempt = 0; ; attempt++) {
  try {
    const client = await connectTerminalDaemon(daemonSocketPath(dataDir));
    client.dispose();
    break;
  } catch (error) {
    if (attempt >= 99 || !['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await setTimeout(100);
  }
}
