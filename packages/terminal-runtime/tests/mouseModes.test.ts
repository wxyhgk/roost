import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMouseModes } from '../src/mouseModes.ts';

const enable = '\x1b[?1003;1006h';
test('mode state follows split commands, protocol switches, disable and RIS', () => {
  const modes = createMouseModes();
  assert.equal(modes.restore(), '');
  modes.absorb('\x1b[?100'); modes.absorb('3;1006h');
  assert.ok(modes.restore().endsWith(enable));
  modes.absorb('\x1b[?1002h\x1b[?1016h');
  assert.ok(modes.restore().endsWith('\x1b[?1002;1016h'));
  modes.absorb('\x1b[?1002;1016l');
  assert.ok(!modes.restore().endsWith('h'));
  modes.absorb(enable + '\x1bc');
  assert.ok(!modes.restore().endsWith('h'));
});

for (const [name, start, end] of [
  ['CSI', '\x1b[38;2;1', ';2;3m'],
  ['OSC', '\x1b]0;title', '\x07'],
  ['DCS', '\x1bPpayload\x07', '\x1b\\'],
  ['charset', '\x1b(', 'B'],
]) {
  test(`repair waits for a split ${name} and preserves all its bytes`, () => {
    const modes = createMouseModes(); modes.absorb(enable);
    assert.equal(modes.absorb(start), start);
    assert.equal(modes.restore(), '');
    assert.equal(modes.restore(), '', 'multiple peers request one shared repair');
    const result = modes.absorb(end + 'VISIBLE');
    assert.ok(result.startsWith(end));
    assert.ok(result.endsWith(enable + 'VISIBLE'));
    assert.equal(modes.absorb('NEXT'), 'NEXT', 'repair is not repeated on every output');
  });
}

test('escape-like data inside strings cannot enable mouse reporting', () => {
  const modes = createMouseModes();
  modes.absorb('\x1b]0;' + enable + '\x07');
  modes.absorb('\x1bP' + enable + '\x1b\\');
  assert.equal(modes.restore(), '');
});

test('an overlong CSI remains pending until its final byte or cancellation', () => {
  const modes = createMouseModes(); modes.absorb(enable);
  modes.absorb('\x1b[' + '1;'.repeat(10_000));
  assert.equal(modes.restore(), '');
  const result = modes.absorb('\x18TEXT');
  assert.ok(result.startsWith('\x18'));
  assert.ok(result.endsWith(enable + 'TEXT'));
});
