import { createRequire } from 'node:module';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// node-pty 1.1.0's macOS prebuild can arrive without executable permission.
// Only repair the installed helper; compiling remains an explicit fallback.
if (process.platform === 'darwin') {
  const require = createRequire(new URL('../packages/terminal-runtime/package.json', import.meta.url));
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const dir of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release', 'build/Debug']) {
    const helper = join(root, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111);
  }
}
