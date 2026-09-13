import { readFile, mkdir, cp, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { exists, hash, write } from './files.mjs';
import { runtimeForTarget } from './targets.mjs';

export async function prepareNode({ lock, target, cache, tauri }) {
  const runtime = runtimeForTarget(lock, target);
  // Archive and extraction caches include the target; no shared bin/node between architectures.
  const targetCache = join(cache, 'node', runtime.nodeVersion, target.triple);
  await mkdir(targetCache, { recursive: true });
  const archive = join(targetCache, runtime.archive);
  if (!await exists(archive)) {
    // Reuse the previous Mac preview download only after verifying its digest below.
    const legacy = join(cache, runtime.archive);
    if (await exists(legacy)) await cp(legacy, archive);
    else {
      const response = await fetch(`https://nodejs.org/dist/${runtime.nodeVersion}/${runtime.archive}`);
      if (!response.ok) throw Error('Node runtime download failed: ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== runtime.sha256) throw Error('Node archive checksum mismatch');
      await write(archive, bytes);
    }
  }
  if (hash(await readFile(archive)) !== runtime.sha256) throw Error('Cached Node archive checksum mismatch');
  const extracted = join(targetCache, 'extracted');
  await mkdir(extracted, { recursive: true });
  const prefix = runtime.archive.replace(/\.(tar\.gz|zip)$/, '');
  // Windows 10+ ships bsdtar, which reads ZIP and preserves the same selected-file layout.
  const tar = target.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archive, '--strip-components=1', '-C', extracted,
    `${prefix}/${target.nodePath}`, `${prefix}/LICENSE`]);
  const node = join(extracted, target.nodePath);
  const actual = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
  if (actual !== runtime.nodeVersion) throw Error('Extracted Node version differs from runtime-lock.json');
  console.log(`Runtime: ${actual} (${target.triple})`);
  const binary = join(tauri, 'binaries', target.sidecar);
  await mkdir(join(tauri, 'binaries'), { recursive: true });
  await cp(node, binary);
  if (target.platform !== 'win32') await chmod(binary, 0o755);
  return { binary, license: join(extracted, 'LICENSE'), nodeVersion: runtime.nodeVersion };
}
