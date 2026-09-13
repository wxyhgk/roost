import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileWatcher } from '../src/watcher.ts';

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** 文件系统事件是异步且平台相关的，只能轮询等它到来。 */
async function waitFor(check: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return check();
}

/**
 * 反复改动直到被观测到。
 *
 * macOS 的 FSEvents 在 watch() 之后有一段布防延迟，紧跟着的第一次写入可能根本
 * 不会被投递。写一次就等，在机器繁忙时会随机超时——这是测试的问题，不是被测
 * 代码的问题：真实用法里监听是长期存在的，不存在这个竞争。
 */
async function pokeUntil(write: (attempt: number) => void, check: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    write(attempt);
    if (await waitFor(check, 400)) return true;
  }
  return check();
}

test('嵌套改动会通知，被忽略的目录不会，并且同窗口内多次改动只推一条', async t => {
  const dir = directory(t);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
  const watcher = createFileWatcher({ debounceMs: 30 });
  t.after(() => watcher.dispose());
  let hits = 0;
  const stop = watcher.watch(dir, () => { hits++; });
  t.after(() => stop());

  assert.ok(
    await pokeUntil(attempt => writeFileSync(join(dir, 'src', `a${attempt}.ts`), 'one'), () => hits > 0),
    '子目录里的新文件必须通知',
  );

  // 一次编译会连着写很多次；合并窗口的意义就是把它们并成一条。
  const before = hits;
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, 'src', `b${i}.ts`), 'x');
  await waitFor(() => hits > before);
  await new Promise(resolve => setTimeout(resolve, 200));
  // 不断言「恰好一条」：机器一忙，20 次写入就可能跨过两个窗口，那是正常的。
  // 要守住的是「远少于 20」——没有合并的话这里会是 20 条起。
  assert.ok(hits - before <= 3, `20 次写入应该合并成个位数，实际推了 ${hits - before} 条`);

  // node_modules 的事件量足以淹掉整条通道，必须被筛掉。
  const quiet = hits;
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'noise');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(hits, quiet, 'node_modules 里的改动不该惊动任何人');
});

test('同一个根共用一个句柄，最后一个订阅方走掉才关掉它', async t => {
  const dir = directory(t);
  const watcher = createFileWatcher({ debounceMs: 20 });
  t.after(() => watcher.dispose());
  let first = 0, second = 0;
  const stopFirst = watcher.watch(dir, () => { first++; });
  const stopSecond = watcher.watch(dir, () => { second++; });
  assert.equal(watcher.size, 1, '同一个根只应该开一个句柄');

  assert.ok(
    await pokeUntil(attempt => writeFileSync(join(dir, `a${attempt}.txt`), '1'), () => first > 0 && second > 0),
    '两个订阅方都要收到',
  );

  stopFirst();
  assert.equal(watcher.size, 1, '还有人在听，句柄不能关');
  const seen = first;
  assert.ok(await pokeUntil(attempt => writeFileSync(join(dir, `b${attempt}.txt`), '2'), () => second > 1));
  assert.equal(first, seen, '退订之后不该再收到');

  stopSecond();
  assert.equal(watcher.size, 0, '最后一个走掉必须回收句柄');
  // 退订是幂等的：连接关闭和组件卸载都可能各调一次。
  stopSecond();
  assert.equal(watcher.size, 0);
});

test('监听不存在的目录会抛出，dispose 之后不再接受订阅', async t => {
  const dir = directory(t);
  const watcher = createFileWatcher({ debounceMs: 20 });
  assert.throws(() => watcher.watch(join(dir, 'missing'), () => {}));
  assert.equal(watcher.size, 0, '开不起来就不该留下半个 room');

  const stop = watcher.watch(dir, () => {});
  assert.equal(watcher.size, 1);
  watcher.dispose();
  assert.equal(watcher.size, 0, 'dispose 必须回收所有句柄');
  stop();
  assert.throws(() => watcher.watch(dir, () => {}), /disposed/);
});

test('ignored trees are never traversed; directory discovery is async and bounded', async t => {
  const dir = directory(t);
  for (const tree of ['node_modules', '.git', '.cache', 'dist']) {
    for (let i = 0; i < 30; i++) mkdirSync(join(dir, tree, 'pkg'+i, 'nested'), {recursive:true});
  }
  mkdirSync(join(dir,'src','nested'), {recursive:true});
  const watcher = createFileWatcher({debounceMs:10, maxDirectories:4});
  t.after(() => watcher.dispose());
  let errors=0;
  watcher.watch(dir,()=>{},()=>errors++);
  assert.equal(watcher.directoryCount,1,'subscription must not synchronously traverse the tree');
  assert.ok(await waitFor(()=>watcher.directoryCount===3));
  await new Promise(r=>setTimeout(r,50));
  assert.equal(errors,0); assert.equal(watcher.directoryCount,3);
  mkdirSync(join(dir,'extra','too-many'),{recursive:true});
  assert.ok(await waitFor(()=>errors===1),'budget overflow must notify the consumer');
  assert.equal(watcher.directoryCount,0,'budget overflow must release all handles');
  assert.equal(watcher.size,0);
});

test('new nested directories are watched; removing them releases handles', async t => {
  const dir=directory(t), watcher=createFileWatcher({debounceMs:10});
  t.after(()=>watcher.dispose());
  let hits=0;watcher.watch(dir,()=>hits++);
  mkdirSync(join(dir,'new','nested'),{recursive:true});
  assert.ok(await waitFor(()=>watcher.directoryCount===3));
  await new Promise(r=>setTimeout(r,100));
  const before=hits;
  assert.ok(await pokeUntil(n=>writeFileSync(join(dir,'new','nested','file.txt'),String(n)),()=>hits>before));
  rmSync(join(dir,'new'),{recursive:true});
  assert.ok(await waitFor(()=>watcher.directoryCount===1));
  watcher.dispose();
  await new Promise(r=>setTimeout(r,50));
  assert.equal(watcher.directoryCount,0,'in-flight discovery must not recreate disposed handles');
});

test('real filesystem aliases and overlapping roots use the canonical directory union', async t => {
  const dir = directory(t);
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
  symlinkSync(join(dir, 'src'), join(dir, 'alias'), 'dir');
  const watcher = createFileWatcher({ debounceMs: 10, maxDirectories: 3 });
  t.after(() => watcher.dispose());
  let errors = 0, childChanges = 0;
  const stopRoot = watcher.watch(dir, () => {}, () => errors++);
  assert.ok(await waitFor(() => watcher.directoryCount === 3));
  const stopAlias = watcher.watch(join(dir, 'alias'), () => childChanges++, () => errors++);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(errors, 0);
  assert.equal(watcher.size, 2);
  assert.equal(watcher.directoryCount, 3, 'symlink alias must share the existing canonical handles');
  stopRoot();
  assert.equal(watcher.directoryCount, 2);
  const before = childChanges;
  assert.ok(await pokeUntil(
    attempt => writeFileSync(join(dir, 'src', 'nested', 'changed.txt'), String(attempt)),
    () => childChanges > before,
  ), 'alias subscriber continues receiving nested native filesystem events');
  stopAlias();
  assert.equal(watcher.directoryCount, 0);
});
