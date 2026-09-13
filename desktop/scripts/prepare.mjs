import { readFile, mkdir, readdir, rm, chmod } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { json, hash, write, portablePath } from './lib/files.mjs';
import { assertBuildable, resolveTarget, parseOptions, runtimeForTarget } from './lib/targets.mjs';
import { runNpm } from './lib/commands.mjs';
import { prepareNode } from './lib/node-runtime.mjs';
import { compileRuntime } from './lib/compile-runtime.mjs';
import { copyDependencies } from './lib/dependencies.mjs';
import { prepareIcons } from './lib/icons.mjs';

export async function prepare(options = {}) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const desktop = join(root, 'desktop'), tauri = join(desktop, 'src-tauri');
  const out = join(tauri, 'resources/runtime'), cache = join(desktop, '.cache');
  const target = resolveTarget(options.target);
  // Refuse unsupported/cross-host targets before touching outputs or downloading anything.
  assertBuildable(target);
  const pkg = await json(join(root, 'package.json'));
  const lock = await json(join(desktop, 'runtime-lock.json'));
  runtimeForTarget(lock, target);
  const node = await prepareNode({ lock, target, cache, tauri });
  if (!options.skipFrontend) runNpm(['run', 'build', '--workspace', 'frontend'], root);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const workspaces = await compileRuntime({ root, desktop, out, pkg, license: node.license });
  const packages = await copyDependencies({ root, out, workspaces, target });
  for (const file of target.executables) await chmod(join(out, file), 0o755);
  await prepareIcons({ root, desktop, cache, tauri });

  const files = {};
  async function inventory(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else files[portablePath(relative(out, path))] = hash(await readFile(path));
    }
  }
  await inventory(out);
  const metadata = {
    schemaVersion: 1, version: pkg.version, target: target.triple,
    nodeVersion: node.nodeVersion, nodeExecutable: target.nodeExecutable,
    nodeHash: hash(await readFile(node.binary)),
    nodeEntitlementsHash: target.entitlements ? hash(await readFile(join(tauri, target.entitlements))) : null,
    executableFiles: target.executables, files,
  };
  const manifest = { ...metadata, buildId: hash(JSON.stringify(metadata)).slice(0, 20) };
  await write(join(out, 'manifest.json'), JSON.stringify(manifest));
  await write(join(tauri, 'runtime-manifest.json'), JSON.stringify(manifest));
  console.log(`Prepared desktop runtime ${manifest.buildId} (${target.triple}): ${Object.keys(files).length} files, ${packages} production packages`);
  return { root, desktop, tauri, target, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await prepare(parseOptions(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
