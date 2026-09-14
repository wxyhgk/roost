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
test('middle-of-line edits and wrapping fall back instead of overwriting authoritative cells', () => {
  const model = warm(); model.input('x', line('> abc', 3)); assert.equal(model.view(), null);
  const edge = createLocalEcho(), prefix = '>'.repeat(37);
  edge.input('a', line(prefix)); edge.observe(line(prefix + 'a')); edge.input('中', line(prefix + 'a'));
  assert.equal(edge.view(), null);
});
