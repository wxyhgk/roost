/*
  `git status --porcelain -z` 的解析。

  这段的失败方式全是**安静地数错**：不抛异常、不报错，只是给出一个和事实不符的数字，
  而使用者正要拿这个数字判断「agent 到底动了什么」。所以每条用例盯的都是一种「看起来
  对、其实错位」的输入。

  用 `-z` 而不是按行切，正是因为文件名里可以有换行——按行切会在那种文件上错位，而那是
  最难发现的一类错（平时一切正常，遇到一个奇怪文件名才开始胡说）。
*/
import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { parsePorcelain } from '../src/git-status.ts';

/** porcelain -z 的记录之间是 NUL，末尾也有一个。 */
const z = (...records: string[]) => records.map(r => r + '\0').join('');

test('空输出是干净的工作区', () => {
  deepEqual(parsePorcelain(''), { kind: 'clean' });
  deepEqual(parsePorcelain('\0'), { kind: 'clean' });
});

test('四类改动各自计数', () => {
  const r = parsePorcelain(z(' M a.ts', 'A  b.ts', ' D c.ts', '?? d.ts'));
  equal(r.kind, 'dirty');
  if (r.kind !== 'dirty') return;
  deepEqual([r.modified, r.added, r.deleted, r.untracked], [1, 1, 1, 1]);
  deepEqual(r.files.map(f => f.path), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
});

test('文件名里有换行也不错位——按行切就是在这儿翻车的', () => {
  const r = parsePorcelain(z(' M weird\nname.ts', '?? next.ts'));
  equal(r.kind, 'dirty');
  if (r.kind !== 'dirty') return;
  deepEqual(r.files.map(f => f.path), ['weird\nname.ts', 'next.ts']);
  equal(r.modified, 1);
  equal(r.untracked, 1);
});

test('重命名要跳过它带的旧路径，否则后面全部错位', () => {
  // R 记录之后紧跟一段旧路径，它不是独立记录。
  const r = parsePorcelain(z('R  new.ts', 'old.ts', ' M after.ts'));
  equal(r.kind, 'dirty');
  if (r.kind !== 'dirty') return;
  deepEqual(r.files.map(f => f.path), ['new.ts', 'after.ts'], '旧路径被当成了一条记录');
  equal(r.files.length, 2);
  equal(r.modified, 2, 'R 和 M 各算一次改动；数成 3 就说明旧路径也被计了');
});

test('路径里有空格和引号原样保留——-z 不转义，不该自作主张去解引号', () => {
  const r = parsePorcelain(z('?? a file "with" quotes.ts'));
  if (r.kind !== 'dirty') return;
  equal(r.files[0].path, 'a file "with" quotes.ts');
});

test('太短或空的记录直接跳过，不产生幽灵条目', () => {
  deepEqual(parsePorcelain(z('', ' M', 'x')), { kind: 'clean' });
});

test('文件很多时列表截断，但计数照实报', () => {
  const many = z(...Array.from({ length: 300 }, (_, i) => `?? f${i}.ts`));
  const r = parsePorcelain(many);
  if (r.kind !== 'dirty') return;
  equal(r.untracked, 300, '计数不能跟着列表一起被截掉——那会少报改动量');
  equal(r.files.length, 200);
  equal(r.truncated, true);
});

test('索引区和工作区各有状态时算一次，不是两次', () => {
  const r = parsePorcelain(z('MM both.ts'));
  if (r.kind !== 'dirty') return;
  equal(r.modified, 1);
  equal(r.files[0].status, 'MM');
});
