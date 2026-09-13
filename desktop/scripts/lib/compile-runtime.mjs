import { readFile, readdir, stat, cp } from 'node:fs/promises';
import { join, dirname, relative, resolve, extname } from 'node:path';
import { transform } from 'esbuild';
import { init, parse } from 'es-module-lexer';
import { json, exists, write, portablePath } from './files.mjs';

export async function compileRuntime({ root, desktop, out, pkg, license }) {
  await init;
  const workspaces = new Map();
  for (const name of await readdir(join(root, 'packages'))) {
    const dir = join(root, 'packages', name);
    if (await exists(join(dir, 'package.json'))) {
      const p = await json(join(dir, 'package.json'));
      workspaces.set(p.name, { dir, pkg: p });
    }
  }

  async function sourceFile(candidate) {
    for (const p of [candidate, candidate.replace(/\.js$/, '.ts'), candidate + '.ts', candidate + '.mjs', candidate + '.js', join(candidate, 'index.ts')])
      if (await exists(p) && (await stat(p)).isFile()) return p;
    throw Error('Unresolved runtime import: ' + candidate);
  }
  async function compiledSpecifier(specifier, importer) {
    let target;
    if (specifier.startsWith('@roost/')) {
      const [scope, name, ...subpath] = specifier.split('/');
      const ws = workspaces.get(scope + '/' + name);
      if (!ws) throw Error('Unknown workspace: ' + specifier);
      const entry = ws.pkg.exports[subpath.length ? './' + subpath.join('/') : '.'];
      if (typeof entry !== 'string') throw Error('Unsupported workspace export: ' + specifier);
      target = join(ws.dir, entry);
    } else if (specifier.startsWith('.')) target = await sourceFile(resolve(dirname(importer), specifier));
    else return specifier;
    let path = portablePath(relative(dirname(importer), target)).replace(/\.ts$/, '.js');
    return path.startsWith('.') ? path : './' + path;
  }
  async function compile(file) {
    const input = await readFile(file, 'utf8');
    const { code } = await transform(input, { loader: extname(file) === '.ts' ? 'ts' : 'js', target: 'node22', format: 'esm', sourcemap: false });
    const [imports] = parse(code);
    let result = code;
    for (const item of [...imports].reverse()) {
      const specifier = item.specifier ?? item.n;
      if (!specifier) continue;
      const rewritten = await compiledSpecifier(specifier, file);
      if (rewritten === specifier) continue;
      const dynamic = item.type === 'dynamic' || (typeof item.d === 'number' && item.d >= 0);
      result = result.slice(0, item.start ?? item.s) + (dynamic ? JSON.stringify(rewritten) : rewritten) + result.slice(item.end ?? item.e);
    }
    await write(join(out, relative(root, file).replace(/\.ts$/, '.js')), result);
  }
  async function sources(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await sources(file);
      else if (!entry.name.endsWith('.d.ts') && /\.(ts|mjs|js)$/.test(entry.name)) await compile(file);
      else if (!entry.name.endsWith('.d.ts')) await write(join(out, relative(root, file)), await readFile(file));
    }
  }
  for (const { dir, pkg: p } of workspaces.values()) {
    await sources(join(dir, 'src'));
    await write(join(out, relative(root, dir), 'package.json'), JSON.stringify({ name: p.name, version: p.version, type: 'module' }));
  }
  await sources(join(root, 'backend/src'));
  await sources(join(desktop, 'runtime'));
  await compile(join(root, 'scripts/agent-message.mjs'));
  await write(join(out, 'backend/package.json'), JSON.stringify({ name: 'backend', version: pkg.version, type: 'module' }));
  await write(join(out, 'package.json'), JSON.stringify({ name: 'roost-runtime', version: pkg.version, type: 'module' }));
  await cp(join(root, 'backend/assets'), join(out, 'backend/assets'), { recursive: true });
  await cp(join(root, 'frontend/dist'), join(out, 'frontend/dist'), { recursive: true });
  await cp(license, join(out, 'NODE-LICENSE'));
  return workspaces;

}
