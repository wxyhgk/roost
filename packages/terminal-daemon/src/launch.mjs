// A detached child is still a descendant until its parent exits. Launch via a
// short-lived intermediary so recursive dev-process cleanup cannot reach PTYs.
import { spawn } from 'node:child_process';
const owner = spawn(process.execPath, process.argv.slice(2), {
  detached: true,
  stdio: 'inherit',
  env: process.env,
});
owner.on('error', error => { console.error('terminal owner launch failed', error); process.exitCode = 1; });
owner.unref();
