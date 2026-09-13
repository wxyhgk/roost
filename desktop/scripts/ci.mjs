import { readFile, mkdir, readdir, cp, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveTarget, assertBuildable } from './lib/targets.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const target = resolveTarget();
assertBuildable(target);
const release = join(root, 'desktop/src-tauri/target', target.triple, 'release');
const mac = target.platform === 'darwin';
const bundle = join(release, 'bundle/macos/Roost.app');
const run = (exe, args, options = {}) => execFileSync(exe, args, { cwd: root, stdio: 'inherit', ...options });
async function installer() {
  const dir = join(release, 'bundle/nsis');
  const names = (await readdir(dir)).filter(name => name.endsWith('-setup.exe'));
  if (names.length !== 1) throw Error('Expected exactly one NSIS installer');
  return join(dir, names[0]);
}

switch (process.argv[2]) {
  case 'metadata': {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw Error('Invalid app version');
    if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== 'v' + pkg.version)
      throw Error('Git tag must match the root package.json version');
    const lock = JSON.parse(await readFile(join(root, 'desktop/runtime-lock.json'), 'utf8'));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `node=${lock.nodeVersion}\nversion=${pkg.version}\n`);
    console.log(`Roost ${pkg.version} / ${target.triple} / ${lock.nodeVersion}`);
    break;
  }
  case 'test': {
    let installed = bundle;
    if (mac) run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    else {
      // NSIS /D is last and unquoted. GitHub's RUNNER_TEMP has no spaces.
      installed = resolve(join(tmpdir(), 'roost-ci-install-' + process.pid));
      if (installed.includes(' ')) throw Error('NSIS smoke install requires a temp directory without spaces');
      run(await installer(), ['/S', '/D=' + installed]);
    }
    run(process.execPath, ['--test', 'desktop/tests/runtime.test.mjs', 'desktop/tests/windows.test.mjs'], { env: { ...process.env, ROOST_DESKTOP_BUNDLE: installed } });
    break;
  }
  case 'package': {
    const out = join(root, 'desktop/artifacts');
    await mkdir(out, { recursive: true });
    const name = `Roost-${pkg.version}-${mac ? 'macos-arm64.zip' : 'windows-x64-setup.exe'}`;
    const file = join(out, name);
    if (mac) run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, file]);
    else await cp(await installer(), file);
    const hash = createHash('sha256').update(await readFile(file)).digest('hex');
    await writeFile(join(out, name + '.sha256'), `${hash}  ${name}\n`);
    const manifest = JSON.parse(await readFile(join(root, 'desktop/src-tauri/runtime-manifest.json'), 'utf8'));
    await writeFile(join(out, 'build-info.json'), JSON.stringify({ version: pkg.version, target: target.triple,
      nodeVersion: manifest.nodeVersion, buildId: manifest.buildId, commit: process.env.GITHUB_SHA ?? null }, null, 2) + '\n');
    console.log(name);
    break;
  }
  default: throw Error('Expected metadata, test or package');
}
