import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalEcho, echoWidth, ECHO_TIMEOUT, type EchoLine } from '../src/features/terminal/engine/localEcho';

function line(text: string, x?: number, y = 2): EchoLine {
  const cells = [...text].flatMap(text => echoWidth(text) === 2 ? [{ text, width: 2 }, { text: '', width: 0 }] : [{ text, width: 1 }]);
  const end = cells.length;
  while (cells.length < 40) cells.push({ text: ' ', width: 1 });
  return { cells, cols: 40, x: x ?? end, y, viewport: 0 };
}
const text = (value: EchoLine) => value.cells.map(cell => cell.text).join('').trimEnd();
function warm() {
  const model = createLocalEcho();
  model.input('a', line('> '));
  assert.equal(model.view(), null, 'do not echo a new/unproven prompt');
  model.observe(line('> a'));
  return model;
}

test('local preview appears before echo and confirms coalesced server output without modifying its input', () => {
  const model = warm(), server = line('> a'), before = structuredClone(server);
  model.input('b', server); model.input('c', server);
  assert.equal(text(model.view()!.predicted), '> abc');
  assert.equal(text(model.view()!.actual), '> a');
  assert.deepEqual(server, before);
  model.observe(line('> abc'));
  assert.equal(model.view(), null);
});
test('partial acknowledgements preserve the remaining prediction', () => {
  const model = warm(), server = line('> a');
  model.input('b', server); model.input('c', server);
  model.observe(line('> ab'));
  assert.equal(text(model.view()!.actual), '> ab');
  assert.equal(text(model.view()!.predicted), '> abc');
  model.observe(line('> abc')); assert.equal(model.view(), null);
});
test('first TUI echo replaces a placeholder and unlocks keys already in flight', () => {
  const model = createLocalEcho(), placeholder = line('> Ask anything', 2);
  model.input('a', placeholder); model.input('b', placeholder); model.input('c', placeholder);
  assert.equal(model.view(), null);
  model.observe(line('> a'));
  assert.equal(text(model.view()!.predicted), '> abc');
  model.observe(line('> abc')); assert.equal(model.view(), null);
});
test('Chinese committed text and backspace use terminal cells, not UTF-16 length', () => {
  const model = warm(), server = line('> a');
  model.input('中文', server);
  assert.equal(model.view()!.predicted.x, 7);
  model.input('\x7f', server);
  assert.equal(text(model.view()!.predicted), '> a中');
  assert.equal(model.view()!.predicted.x, 5);
  model.observe(line('> a中文'));
  assert.equal(text(model.view()!.predicted), '> a中');
  model.observe(line('> a中')); assert.equal(model.view(), null);
});
test('screen disagreement, resize, scrolling, timeout and explicit reset discard predictions', () => {
  for (const output of [line('> unrelated'), { ...line('> a'), cols: 39 }, { ...line('> a'), viewport: 1 }]) {
    const model = warm(); model.input('b', line('> a')); model.observe(output); assert.equal(model.view(), null);
  }
  let now = 0; const model = createLocalEcho(() => now);
  model.input('a', line('> ')); model.observe(line('> a')); model.input('b', line('> a'));
  now = ECHO_TIMEOUT; assert.equal(model.view(), null);
  model.input('c', line('> a')); assert.equal(model.view(), null, 'timeout also loses confidence');
  model.clear(); assert.equal(model.view(), null);
});
test('non-echoing input stays invisible, and controls invalidate an established run', () => {
  const model = createLocalEcho();
  for (const char of 'secret') { model.input(char, line('Password: ')); model.observe(line('Password: ')); assert.equal(model.view(), null); }
  const masked = createLocalEcho();
  masked.input('*', line('Password: ')); masked.observe(line('Password: *'));
  masked.input('secret', line('Password: *')); assert.equal(masked.view(), null, 'password mask matching a typed star does not establish confidence');
  for (const data of ['\r', '\x03', '\x1b[D', '\t', '\x1b[200~paste\x1b[201~', '👩‍💻', 'e\u0301']) {
    const m = warm(); m.input('b', line('> a')); m.input(data, line('> a')); assert.equal(m.view(), null);
    m.input('c', line('> a')); assert.equal(m.view(), null);
  }
});
/*
  输入长到折行时，光标推到下一行、`sameGrid` 变假。原来这里整个 `clear()`——连 `trusted`
  一起清掉，于是折行那一下要付**两次**完整往返（折行本身一次，重新证明「这个提示符会
  回显」又一次）。[实测] 抓 claude 2.1.273 真实字节跑一段 110 字符的输入，折行处正好连丢
  两次；跨太平洋链路上就是打字中间莫名卡 ~400ms，而折行落在哪取决于打了多长，所以每次
  卡的位置都不一样。
*/
test('软换行不丢信任：折行之后下一个字符仍然立刻预览', () => {
  const model = warm();                        // 已确认 '> a'，y=2
  model.input('b', line('> a'));
  model.observe(line('  cd', 4, 3));           // 折到下一行，列数和视口都没变
  model.input('e', line('  cd', 4, 3));
  assert.ok(model.view(), '折行之后不该再要一个完整往返');
});

test('列数变、视口变、跳行都不是折行，仍然整个清空', () => {
  // 只有「同列数、同视口、正好下一行」算折行。resize / 滚动 / 跳两行都不是。
  for (const [what, next] of [
    ['列数变了', { ...line('  cd', 4, 3), cols: 39 }],
    ['视口变了', { ...line('  cd', 4, 3), viewport: 1 }],
    ['跳了两行', line('  cd', 4, 4)],
  ] as const) {
    const model = warm();
    model.input('b', line('> a'));
    model.observe(next);
    model.input('e', line('  cd', 4, 3));
    assert.equal(model.view(), null, `${what} 不该被当成折行`);
  }
});

/*
  实测 claude 2.1.273（PTY 抓包）：在行尾打一个空格，回显是 `ESC[1C` —— 只把光标右移
  一格，一个字符都不写。于是屏幕文字和上一帧完全相同。

  「终端真的回显了」的证据原来只认文字变，这一格就掉信任，下一个字符要等一整个往返。
  正常行文每 5、6 个字符一个空格，跨太平洋的链路（实测北京↔洛杉矶 ~200ms）上就是每
  六次按键卡一次。
*/
test('行尾空格只推光标不改文字，不该因此丢掉信任', () => {
  const model = warm();                       // 已确认 '> a'
  model.input(' ', line('> a'));
  model.observe(line('> a', 4));              // ESC[1C：文字没变，光标 3 → 4
  model.input('b', line('> a', 4));
  assert.ok(model.view(), '空格之后下一个字符仍应立刻预览，而不是等一个完整往返');
  assert.equal(text(model.view()!.predicted), '> a b');
});

test('middle-of-line edits and wrapping fall back instead of overwriting authoritative cells', () => {
  const model = warm(); model.input('x', line('> abc', 3)); assert.equal(model.view(), null);
  const edge = createLocalEcho(), prefix = '>'.repeat(37);
  edge.input('a', line(prefix)); edge.observe(line(prefix + 'a')); edge.input('中', line(prefix + 'a'));
  assert.equal(edge.view(), null);
});
