import { readFile, mkdir, cp, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { exists, hash, write } from './files.mjs';
import { runtimeForTarget } from './targets.mjs';

/**
 * 取回一个归档，失败就重试。
 *
 * 这是一次约 30 MB 的下载，而且每次 CI 都会真的走网络（归档没有缓存）。原来只试一次，
 * 于是 runner 上一次瞬时的 `fetch failed` 就让整条流水线变红——和被构建的代码毫无关系。
 *
 * 重试是**安全**的，因为紧接着就按 runtime-lock.json 里的 sha256 校验：内容不对会当场
 * 报错，不会把半截或被掉包的归档留在缓存里。所以这里重试的只是「有没有拿到」，
 * 不是「拿到的对不对」。
 *
 * 次数和间隔都有上限：CI 的价值在于快速给出答案，一直重试只会把「网络坏了」伪装成
 * 「构建很慢」。HTTP 4xx 不重试——那是地址或版本写错了，再试一百次也一样。
 */
export async function download(url, sha256, attempts = 4, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const error = Error(`Node runtime download failed: ${response.status}`);
        // 4xx 是我们自己写错了（版本号、文件名对不上），再试一百次也一样。
        error.permanent = response.status < 500;
        throw error;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      // 校验不过也重试：下到一半被截断正是瞬时故障的样子。锁文件写错的话，
      // 重试几次也过不了，最终照样报出来。
      if (hash(bytes) !== sha256) throw Error('Node archive checksum mismatch');
      return bytes;
    } catch (error) {
      last = error;
      if (error.permanent || attempt === attempts) break;
      const delay = 1000 * 2 ** (attempt - 1);
      console.warn(`Node runtime download attempt ${attempt}/${attempts} failed (${error.message}); retrying in ${delay}ms`);
      await wait(delay);
    }
  }
  throw last;
}

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
    else await write(archive, await download(`https://nodejs.org/dist/${runtime.nodeVersion}/${runtime.archive}`, runtime.sha256));
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
