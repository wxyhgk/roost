import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Invoke JS entrypoints with Node; do not depend on Unix .bin shims or cmd.exe quoting.
export function runNpm(args, root) {
  if (!process.env.npm_execpath) throw Error('Run desktop commands through npm run desktop:prepare/build/dev.');
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, stdio: 'inherit' });
}

export function runTauri(args, root, cwd) {
  const require = createRequire(join(root, 'package.json'));
  const cli = require.resolve('@tauri-apps/cli/tauri.js');
  execFileSync(process.execPath, [cli, ...args], { cwd, stdio: 'inherit' });
}
