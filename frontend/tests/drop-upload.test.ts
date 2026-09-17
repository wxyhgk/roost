/*
  拖放展开成文件清单。这三个坑的表现都是**静默少传**，而且都在小样本上测不出来，
  所以每一个都单独钉一条（说明见 dropUpload.ts 顶部）。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDropEntries, readDropTree } from '../src/features/files/dropUpload';

type FakeEntry = ReturnType<typeof fileEntry> | ReturnType<typeof dirEntry>;

/*
  **替身必须是异步的。**

  浏览器的 `entry.file()` 和 `readEntries()` 都是「立刻返回、稍后回调」。
  替身当场同步 resolve 的话，会把真实实现里的竞争全部掩盖掉——第一版就是这么漏掉了
  `entry.file?.(…) ?? resolve(null)`：那句每次都会同步 resolve(null)，同步替身抢赢了所以
  测试全绿，而真浏览器上一个文件都传不出去。
*/
const later = (run: () => void) => setTimeout(run, 0);

function fileEntry(name: string, size = 1) {
  return {
    name, isFile: true as const, isDirectory: false as const,
    file(resolve: (file: File) => void) { later(() => resolve({ name, size } as File)); },
  };
}

/** 照真实实现建模：`readEntries` 一批最多 `batch` 条，读完之后回空数组。 */
function dirEntry(name: string, children: FakeEntry[], batch = 100) {
  return {
    name, isFile: false as const, isDirectory: true as const,
    createReader() {
      let offset = 0;
      return {
        readEntries(resolve: (entries: FakeEntry[]) => void) {
          const slice = children.slice(offset, offset + batch);
          offset += slice.length;
          later(() => resolve(slice));
        },
      };
    },
  };
}

const read = (entries: unknown[]) => readDropTree(entries as Parameters<typeof readDropTree>[0]);

test('文件夹递归展开，路径是一路拼出来的', async () => {
  const tree = await read([dirEntry('src', [fileEntry('a.ts'), dirEntry('deep', [fileEntry('b.ts')])])]);
  assert.deepEqual(tree.files.map(f => f.path), ['src/a.ts', 'src/deep/b.ts']);
  assert.deepEqual(tree.directories, ['src', 'src/deep']);
});

/*
  坑 2：`readEntries` 一次最多给 100 条。只读一次的话第 101 个之后全部安静消失——
  拿三五个文件测永远发现不了，而拖一个真实的源码目录就少一半。
*/
test('一次读不完的目录要读到空为止 —— 120 个文件一个都不能少', async () => {
  const children = Array.from({ length: 120 }, (_, i) => fileEntry(`f${i}.txt`));
  const tree = await read([dirEntry('many', children)]);
  assert.equal(tree.files.length, 120, '少掉的那些就是「只读一次」的症状');
  assert.equal(tree.files.at(-1)!.path, 'many/f119.txt');
});

test('顶层的散文件不带目录前缀，目录按深度排序', async () => {
  const tree = await read([fileEntry('top.txt'), dirEntry('a', [dirEntry('b', [fileEntry('c.txt')])])]);
  assert.equal(tree.files[0].path, 'top.txt');
  // 浅的在前：调用方顺着建目录就不会缺父目录。
  assert.deepEqual(tree.directories, ['a', 'a/b']);
});

test('统计字节数和隐藏文件数；隐藏文件照传不漏', async () => {
  const tree = await read([dirEntry('p', [fileEntry('.env', 10), fileEntry('app.ts', 90), fileEntry('.gitignore', 5)])]);
  assert.equal(tree.files.length, 3, '隐藏文件不过滤，只是单独报个数');
  assert.equal(tree.totalBytes, 105);
  assert.equal(tree.hidden, 2);
});

test('读不出来的条目跳过，不拖垮其余的', async () => {
  const broken = { name: 'broken', isFile: true as const, isDirectory: false as const,
    file(_ok: unknown, fail: (error: unknown) => void) { later(() => fail(new Error('gone'))); } };
  const tree = await read([dirEntry('p', [broken, fileEntry('ok.txt')])]);
  assert.deepEqual(tree.files.map(f => f.path), ['p/ok.txt']);
});

/* 符号链接可以成环。没有深度上限的话这里会转到天荒地老，而不是报错。 */
test('层数过深时停下并说出来，不是转死也不是假装读完了', async () => {
  let deepest: FakeEntry = fileEntry('bottom.txt');
  for (let i = 0; i < 40; i++) deepest = dirEntry(`d${i}`, [deepest]);
  const tree = await read([deepest]);
  assert.equal(tree.stopped, true, '撞上限必须报出来，否则调用方会把不全的清单当成全的');
});

test('collectDropEntries 只收 file 类型，拿不到 entry 的跳过', () => {
  const items = [
    { kind: 'string', webkitGetAsEntry: () => fileEntry('ignored.txt') },
    { kind: 'file', webkitGetAsEntry: () => null },
    { kind: 'file', webkitGetAsEntry: () => fileEntry('kept.txt') },
  ];
  const entries = collectDropEntries(items as unknown as DataTransferItemList);
  assert.deepEqual(entries.map(e => e.name), ['kept.txt']);
});

test('应用内部的拖放（没有 Files）读出来是空的', () => {
  assert.deepEqual(collectDropEntries(null), []);
  assert.deepEqual(collectDropEntries([] as unknown as DataTransferItemList), []);
});
