import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// Resolve from the actual consumer, whether npm hoists the native module or not.
const require = createRequire(new URL('../packages/terminal-runtime/package.json', import.meta.url));
const cwd = dirname(require.resolve('node-pty/package.json'));
if (process.argv.includes('--dry-run')) {
  console.log(cwd);
} else {
  const result = spawnSync('npm', ['rebuild', 'node-pty', '--build-from-source'], {
    cwd, stdio: 'inherit', env: process.env,
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}
