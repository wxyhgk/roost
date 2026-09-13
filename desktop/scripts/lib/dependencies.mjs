import { cp } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { json, exists, portablePath } from './files.mjs';
import { supportsTarget } from './targets.mjs';

// Retain Node's nested module resolution and licenses, selecting this host's native dependencies.
export async function copyDependencies({ root, out, workspaces, target }) {
  const copied = new Set();
  async function dependency(name, from, optional = false) {
    // Development workers use tsx; all desktop workers have already been compiled.
    if (name === 'tsx') return;
    if (workspaces.has(name)) return;
    let base = from, found;
    while (base.startsWith(root)) {
      const candidate = join(base, 'node_modules', name);
      if (await exists(join(candidate, 'package.json'))) { found = candidate; break; }
      if (base === root) break;
      base = dirname(base);
    }
    if (!found) { if (optional) return; throw Error('Missing dependency: ' + name); }
    if (copied.has(found)) return;
    const p = await json(join(found, 'package.json'));
    if (!supportsTarget(p, target)) return;
    copied.add(found);
    await cp(found, join(out, relative(root, found)), { recursive: true, dereference: true, filter: path => {
      const local = portablePath(relative(found, path)).split('/');
      if (local.some(part => ['node_modules', 'test', 'tests', '__tests__', '.github'].includes(part))) return false;
      if (/\.(map|tsbuildinfo)$/.test(path) || path.endsWith('.d.ts')) return false;
      if (name === 'node-pty') {
        if (['src', 'deps', 'third_party', 'typings', 'scripts'].includes(local[0])) return false;
        if (local[0] === 'prebuilds' && local[1] && local[1] !== target.prebuild) return false;
      }
      return true;
    } });
    for (const dep of Object.keys(p.dependencies ?? {})) await dependency(dep, found);
    for (const dep of Object.keys(p.optionalDependencies ?? {})) await dependency(dep, found, true);
  }
  const production = [await json(join(root, 'backend/package.json')), ...[...workspaces.values()].map(w => w.pkg)];
  for (const p of production) for (const name of Object.keys(p.dependencies ?? {})) await dependency(name, root);
  return copied.size;
}
