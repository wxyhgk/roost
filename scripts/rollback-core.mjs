import { readlink, symlink, rename, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/*
  回到上一个 core release。

  **回滚必须同时翻转 `previous`,否则只能回滚一次。** 第一版只写 `current ← previous`,
  于是回滚之后 `current === previous`:第二次回滚是个空操作(看起来成功、什么都没变),
  而且之后一次 `install-core` 会把 `previous` 设成那个旧的 current——**你再也回不到被
  回滚掉的那个较新版本了**。两个指针要当成一对来换,不是一个方向的赋值。

  顺序是先 `current` 再 `previous`:中间崩掉的话,回滚这件事已经生效(用户要的那一半成了),
  丢的只是"再翻回去"的能力,而下一次安装会把 `previous` 重新设对。反过来则是回滚没生效、
  指针却已经乱了。
*/
const root = resolve(process.env.CORE_INSTALL_DIR ?? join(homedir(), '.roost', 'core'));
const previous = await readlink(join(root, 'previous'));
await access(join(root, previous, 'core.mjs'));
const current = await readlink(join(root, 'current')).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

/*
  两个指针指向同一个 release 时**明说没得回滚**,不要静默"成功"。

  release 目录按内容哈希命名,所以用同一份源码重装会得到同一个名字;加上回滚本身也会
  让两者相等。这时候照常翻一遍软链、再打印一句「已回到上一版」,是在报告一件没发生的事。
*/
if (current !== null && current === previous) {
  console.error(`previous and current both point at ${previous}; there is nothing to roll back to.`);
  process.exit(1);
}

async function point(name, target) {
  const temp = join(root, '.' + name + '-' + randomUUID());
  await symlink(target, temp);
  await rename(temp, join(root, name));
}
await point('current', previous);
if (current) await point('previous', current);
console.log('Selected previous core release. Restart only core-server to load it; daemon and PTYs are unaffected.');
