import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDiffHunks } from '../src/features/conversations/tools/diff-adapter.ts';

const patch = (lines: string[], filePath = 'a.ts') => ({
  filePath, truncated: false,
  hunks: [{ oldStart: 12, oldLines: 3, newStart: 12, newLines: 3, lines }],
});

test('每个 hunk 各自成一条，新旧两窗各取各的行', () => {
  const [hunk] = toDiffHunks(patch([
    '   for (const line of lines) {',
    '-    if (!line.trim()) continue;',
    '+    if (!line.trim()) break;',
    '     const cols = line.split(/\\s+/);',
  ]));
  assert.equal(hunk.path, 'a.ts');
  assert.equal(hunk.oldText, '  for (const line of lines) {\n    if (!line.trim()) continue;\n    const cols = line.split(/\\s+/);');
  assert.equal(hunk.newText, '  for (const line of lines) {\n    if (!line.trim()) break;\n    const cols = line.split(/\\s+/);');
});

test('多个 hunk 不能合并成整个文件的新旧两份', () => {
  /*
    合并的话，hunk 之间那些没给我们的行就缺了，重新 diff 会把它们当成删除——
    一次「改了三行」会画成「删掉半个文件」。逐 hunk 换算每一窗自成一体，不会。
  */
  const two = toDiffHunks({ filePath: 'a.ts', truncated: false, hunks: [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] },
    { oldStart: 90, oldLines: 1, newStart: 90, newLines: 1, lines: ['-z', '+Z'] },
  ] });
  assert.equal(two.length, 2);
  assert.deepEqual(two.map(h => h.oldText), ['a', 'z']);
  assert.deepEqual(two.map(h => h.newText), ['A', 'Z']);
});

test('纯新增和纯删除：另一侧是空串不是缺失', () => {
  assert.equal(toDiffHunks(patch(['+x', '+y']))[0].oldText, '');
  assert.equal(toDiffHunks(patch(['-x', '-y']))[0].newText, '');
});

test('上下文里的空行两边都要，diff 的元信息行丢掉', () => {
  const [hunk] = toDiffHunks(patch([' a', ' ', ' b', '\\ No newline at end of file']));
  assert.equal(hunk.oldText, 'a\n\nb');
  assert.equal(hunk.newText, 'a\n\nb');
});

test('空 hunk 不产出——画出来只是个空框', () => {
  assert.deepEqual(toDiffHunks(patch([])), []);
  assert.deepEqual(toDiffHunks(patch(['\\ No newline at end of file'])), []);
});

test('没有文件名时 path 是空串，不是 undefined', () => {
  const [hunk] = toDiffHunks({ truncated: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] });
  assert.equal(hunk.path, '');
});
