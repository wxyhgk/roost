import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closeMolecule, getMolecule, noteMoleculeSaved, openMolecule,
  resetMolecule, setMoleculeDirty, subscribeMolecule,
} from '../src/molecule/editorTarget.ts';

const target = (path: string, sessionId = 's1', root = '/repo') => ({ sessionId, root, path });

test('关掉之后仍然记得编的是哪个文件——iframe 还活着，它得有归属', () => {
  resetMolecule();
  openMolecule(target('a.mol'));
  assert.deepEqual(getMolecule().open, target('a.mol'));

  closeMolecule();
  assert.equal(getMolecule().open, null, '关了就是关了');
  assert.deepEqual(getMolecule().last, target('a.mol'), '但 last 留着：编辑器没被销毁');
});

/*
  快照必须是同一个对象引用，直到真的变了为止。

  useSyncExternalStore 每次渲染都会比 getSnapshot 的结果，每次都新建对象会把自己
  转进无限循环——这条不是风格问题，是会把页面转死的。
*/
test('没有实际变化时快照引用不变', () => {
  resetMolecule();
  openMolecule(target('a.mol'));
  const first = getMolecule();

  openMolecule(target('a.mol'));
  assert.equal(getMolecule(), first, '打开同一个文件不该产生新快照');
  setMoleculeDirty(false);
  assert.equal(getMolecule(), first, 'dirty 没变也不该');

  setMoleculeDirty(true);
  assert.notEqual(getMolecule(), first, '真的变了才换引用');
});

test('订阅者只在变化时被叫醒，退订之后不再被叫', () => {
  resetMolecule();
  let calls = 0;
  const stop = subscribeMolecule(() => { calls++; });

  openMolecule(target('a.mol'));
  assert.equal(calls, 1);
  openMolecule(target('a.mol'));
  assert.equal(calls, 1, '同一个目标不算变化');
  openMolecule(target('b.mol'));
  assert.equal(calls, 2);

  stop();
  closeMolecule();
  assert.equal(calls, 2);
});

test('换文件会清掉未保存标记，否则旧文件的脏状态会赖到新文件上', () => {
  resetMolecule();
  openMolecule(target('a.mol'));
  setMoleculeDirty(true);
  openMolecule(target('b.mol'));
  assert.equal(getMolecule().dirty, false);
});

test('关闭时把未保存标记一并清掉：关着的编辑器不该再拦任何操作', () => {
  resetMolecule();
  openMolecule(target('a.mol'));
  setMoleculeDirty(true);
  closeMolecule();
  assert.equal(getMolecule().dirty, false);
});

test('保存计数只增不减，文件树靠它判断要不要刷新', () => {
  resetMolecule();
  openMolecule(target('a.mol'));
  const before = getMolecule().saved;
  noteMoleculeSaved();
  noteMoleculeSaved();
  assert.equal(getMolecule().saved, before + 2);
  // 关闭不重置计数：否则关掉再打开会被误判成「又保存了一次」。
  closeMolecule();
  assert.equal(getMolecule().saved, before + 2);
});

test('已经关着时再关一次不产生变化，不会白叫醒订阅者', () => {
  resetMolecule();
  let calls = 0;
  subscribeMolecule(() => { calls++; });
  closeMolecule();
  assert.equal(calls, 0);
});
