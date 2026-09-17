/*
  同时开着的几个预览窗。

  这里只测纯函数那一半——「有哪几个窗口、谁压着谁」。钉住这件事的全部意义就在
  `syncPanes`：钉住的不跟着 `selected` 走，没钉住的跟着走。剩下的改名、删除、置顶
  都是围着这个列表打转。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cascadeOffset, dropPanes, freeSlot, raisePane, renamePanes, syncPanes, type Pane,
} from '../src/features/files/usePreviewPanes';

const pane = (path: string, pinned = false, slot = 0, root = '/w'): Pane => ({ path, root, pinned, slot });

test('没钉住的那个跟着选中走：开下一个文件就把它顶掉', () => {
  const next = syncPanes([pane('a.ts')], 'b.ts', '/w');
  assert.deepEqual(next.map(p => p.path), ['b.ts']);
});

test('钉住的不跟着选中走 —— 这就是「能同时看几个」的全部机关', () => {
  const next = syncPanes([pane('a.ts', true)], 'b.ts', '/w');
  assert.deepEqual(next.map(p => p.path), ['a.ts', 'b.ts']);
  assert.deepEqual(next.map(p => p.pinned), [true, false], '新开的那个是临时的，下一次打开会顶掉它');
});

test('选中清空后钉住的还在，临时的没了', () => {
  // 「钉住」这个动作本身走的就是这条路：把 pinned 翻成 true，然后清掉选中。
  const next = syncPanes([pane('a.ts', true), pane('b.ts')], null, '/w');
  assert.deepEqual(next.map(p => p.path), ['a.ts']);
});

test('点一个已经开着的文件：置顶，但不重建 —— 钉住状态和当初的 root 都得留着', () => {
  const pinned = pane('a.ts', true, 0, '/old');
  const next = syncPanes([pinned, pane('b.ts', true, 1)], 'a.ts', '/new');
  assert.deepEqual(next.map(p => p.path), ['b.ts', 'a.ts'], '末尾在最上面');
  const again = next.at(-1)!;
  assert.equal(again, pinned, '必须是同一个对象：换了就等于换了实例，编辑器里没存的改动会没');
  assert.equal(again.root, '/old', '终端后来 cd 走了，这个窗口还该读当初那个文件');
});

test('只开一个窗口时永远落在第 0 格，也就是正中', () => {
  assert.deepEqual(cascadeOffset(freeSlot([])), { x: 0, y: 0 });
  const first = syncPanes([], 'a.ts', '/w')[0];
  assert.equal(first.slot, 0);
});

test('级联挑最小的空格子，关掉中间那个之后空出来的格子会被重新用上', () => {
  assert.equal(freeSlot([pane('a', true, 0), pane('b', true, 1)]), 2);
  assert.equal(freeSlot([pane('a', true, 0), pane('b', true, 2)]), 1, '空出来的格子要补回去，不然窗口一路往右下角爬');
});

test('置顶就是挪到末尾；已经在末尾的原样返回，省一次重渲染', () => {
  const list = [pane('a', true), pane('b', true), pane('c', true)];
  assert.deepEqual(raisePane(list, 'a').map(p => p.path), ['b', 'c', 'a']);
  assert.equal(raisePane(list, 'c'), list);
  assert.equal(raisePane(list, 'nope'), list);
});

test('改名跟着挪，被改名目录底下的窗口也要挪', () => {
  const next = renamePanes([pane('src/a.ts', true), pane('src/deep/b.ts', true), pane('other.ts', true)], 'src', 'lib');
  assert.deepEqual(next.map(p => p.path), ['lib/a.ts', 'lib/deep/b.ts', 'other.ts']);
});

/*
  删掉的文件不能留一个还开着的窗口：屏幕上是一份已经不存在的内容，而那个窗口还能
  按保存——一按就把删掉的文件又写回去了。
*/
test('删掉目录把底下开着的窗口全关掉，同前缀但不是子路径的不动', () => {
  const next = dropPanes([pane('src/a.ts', true), pane('src2/b.ts', true), pane('src', true)], 'src', true);
  assert.deepEqual(next.map(p => p.path), ['src2/b.ts']);
});

test('删掉单个文件只关它自己', () => {
  const next = dropPanes([pane('a.ts', true), pane('b.ts', true)], 'a.ts', false);
  assert.deepEqual(next.map(p => p.path), ['b.ts']);
});
