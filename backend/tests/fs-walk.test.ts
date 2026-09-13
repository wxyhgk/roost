import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkFiles } from '../src/fs.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-walk-'));
  const make = (rel: string, body = 'x') => {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  };
  return { dir, make, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('广度优先列出文件，带上相对路径', async (t) => {
  const { dir, make, cleanup } = fixture();
  t.after(cleanup);
  make('a.txt'); make('src/b.ts'); make('src/deep/c.ts');

  const { files, truncated } = await walkFiles(dir);
  assert.equal(truncated, false);
  assert.deepEqual(files.map(f => f.path).sort(), ['a.txt', 'src/b.ts', 'src/deep/c.ts']);
  assert.equal(files.find(f => f.path === 'src/deep/c.ts')?.name, 'c.ts');
});

/*
  搜索跳过的目录比列目录那份宽。

  列目录只看一层，进不进 `target/` 无所谓；搜索是递归的，一个 `.venv` 就能把预算
  吃光，让真正想找的源码挤不进结果。
*/
test('依赖与构建产物目录不走进去', async (t) => {
  const { dir, make, cleanup } = fixture();
  t.after(cleanup);
  make('keep.ts');
  for (const skip of ['node_modules', 'dist', '.git', 'build', 'target', '__pycache__', '.venv', 'vendor', 'coverage']) {
    make(`${skip}/junk.ts`);
  }

  const { files } = await walkFiles(dir);
  assert.deepEqual(files.map(f => f.path), ['keep.ts']);
});

test('深度有上限，超过的不再往下走', async (t) => {
  const { dir, make, cleanup } = fixture();
  t.after(cleanup);
  make('l1/l2/l3/deep.ts');
  make('top.ts');

  assert.deepEqual((await walkFiles(dir, { depth: 1 })).files.map(f => f.path), ['top.ts']);
  const two = await walkFiles(dir, { depth: 4 });
  assert.ok(two.files.some(f => f.path === 'l1/l2/l3/deep.ts'), '深度够时能走到底');
});

/*
  预算用完时留下的应该是**浅层**的文件——那是人更可能在找的。
  深度优先会把预算花在第一条支路上，所以这里必须是广度优先。
*/
test('条数用完时先保住浅层的文件，并且如实报 truncated', async (t) => {
  const { dir, make, cleanup } = fixture();
  t.after(cleanup);
  make('shallow-1.ts'); make('shallow-2.ts');
  for (let i = 0; i < 20; i++) make(`nested/deep/file-${i}.ts`);

  const { files, truncated } = await walkFiles(dir, { limit: 2 });
  assert.equal(files.length, 2);
  assert.equal(truncated, true);
  assert.deepEqual(files.map(f => f.path).sort(), ['shallow-1.ts', 'shallow-2.ts']);
});

/*
  遍历不能顺着符号链接走到 root 外面去。这个接口的 root 是经过归属校验的终端工作目录，
  一个指向 / 的链接不该把整块磁盘变成可搜的。
*/
test('指向 root 外面的符号链接走不出去', async (t) => {
  const { dir, make, cleanup } = fixture();
  t.after(cleanup);
  const outside = mkdtempSync(join(tmpdir(), 'roost-walk-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.txt'), 'no');
  make('inside.ts');
  symlinkSync(outside, join(dir, 'escape'));

  const { files } = await walkFiles(dir);
  assert.ok(!files.some(f => f.name === 'secret.txt'), 'root 外面的文件不该出现在结果里');
  assert.ok(files.some(f => f.path === 'inside.ts'));
});

test('单个目录读不动时跳过它，不让整次搜索失败', async (t) => {
  const { dir, make, cleanup } = fixture();
  t.after(cleanup);
  make('ok.ts');
  mkdirSync(join(dir, 'locked'));
  // 目录存在但不可读：遍历该跳过它，其余结果照常返回
  const { chmodSync } = await import('node:fs');
  chmodSync(join(dir, 'locked'), 0o000);

  let files;
  // 权限在这里恢复而不是放进 t.after：after 钩子按注册顺序跑，删临时目录那个排在前面，
  // 会先撞上一个删不掉的 000 目录。
  try { ({ files } = await walkFiles(dir)); } finally { chmodSync(join(dir, 'locked'), 0o755); }
  assert.ok(files.some(f => f.path === 'ok.ts'));
});
