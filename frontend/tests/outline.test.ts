/*
  对话目录的两条纯逻辑。界面上那一条竖排刻度靠它算。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeOutlineIndex, outlineOf } from '../src/features/conversations/outline';
import type { Item } from '../src/features/conversations/parts';

const text = (role: string, value: string): Item =>
  ({ kind: 'text', key: role + value, role, text: value, turnStart: false, message: {} } as never);
const tools = (): Item => ({ kind: 'tools', key: 't' + Math.random(), role: 'assistant', tools: [], status: 'completed', message: {}, turnStart: false } as never);

test('每一次提问一个刻度，agent 那一侧不算', () => {
  const entries = outlineOf([
    text('user', '第一个问题'), text('assistant', '回答'), tools(),
    text('user', '第二个问题'), text('assistant', '回答'),
  ]);
  assert.deepEqual(entries.map(e => [e.index, e.label]), [[0, '第一个问题'], [3, '第二个问题']]);
});

test('空问题不给刻度——点过去什么都没有', () => {
  assert.deepEqual(outlineOf([text('user', '   '), text('user', '真的问题')]).map(e => e.label), ['真的问题']);
});

test('很长的问题要截短', () => {
  const entry = outlineOf([text('user', '一'.repeat(200))])[0]!;
  assert.ok(entry.label.length <= 81, '刻度上放不下整段');
});

test('空白要压成一格，多行问题不能把提示框撑坏', () => {
  /*
    换行必须在**截断之前**就压掉。拿一段很长的文本去测这件事是测不出来的——
    换行早被截没了（变异测试发现）。所以反例要短，让换行留在可见范围里。
  */
  const entry = outlineOf([text('user', '第一行\n第二行   还有   空格')])[0]!;
  assert.equal(entry.label, '第一行 第二行 还有 空格');
});

test('当前刻度取「起点不晚于视口顶端的最后一个」', () => {
  const entries = [{ index: 0, label: 'a' }, { index: 10, label: 'b' }, { index: 20, label: 'c' }];
  assert.equal(activeOutlineIndex(entries, 0), 0);
  assert.equal(activeOutlineIndex(entries, 9), 0, '还没到下一次提问，就还在上一段里');
  assert.equal(activeOutlineIndex(entries, 10), 1, '正好到了就算下一段');
  assert.equal(activeOutlineIndex(entries, 999), 2);
});

test('视口在第一次提问之前时不硬选第一个', () => {
  /*
    翻到很早的历史时，视口可能落在第一次提问**之前**（开场的系统消息、工具输出）。
    硬选第一个会让刻度显示成「你在读第一次提问」，而其实不在——那是在撒谎。
  */
  assert.equal(activeOutlineIndex([{ index: 5, label: 'a' }], 0), -1);
  assert.equal(activeOutlineIndex([], 0), -1, '一条提问都没有时也不能选中');
});
