import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm';
import { bufferFileLinks } from '../src/features/terminal/fileLinkBuffer';
import { emitFileLink, subscribeFileLink, subscribeFileLinkOpen } from '../src/features/terminal/fileLinks';

function buffer(rows: { chars: string[]; wrapped?: boolean }[]) {
  const lines = rows.map(row => {
    const cells = row.chars.flatMap(chars => {
      const width = /[\p{Script=Han}]/u.test(chars) ? 2 : 1;
      const cell = { getChars: () => chars, getWidth: () => width } as IBufferCell;
      return width === 2 ? [cell, { getChars: () => '', getWidth: () => 0 } as IBufferCell] : [cell];
    });
    return { isWrapped: !!row.wrapped, length: cells.length, getCell: (x: number) => cells[x] } as IBufferLine;
  });
  return { length: lines.length, getLine: (y: number) => lines[y] } as Pick<IBuffer, 'getLine' | 'length'>;
}

test('provider reads the requested 1-based row and uses inclusive cell endpoints', () => {
  const b = buffer([{ chars: [...'a.ts'] }, { chars: [...'b.py'] }]);
  assert.deepEqual(bufferFileLinks(b, 1, 20)[0], {
    path: 'a.ts', line: undefined, range: { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } },
  });
  assert.equal(bufferFileLinks(b, 2, 20)[0].path, 'b.py');
});

test('Chinese and combining glyphs before a link do not shift its clickable cells', () => {
  const b = buffer([{ chars: ['中', 'e\u0301', ' ', ...'src/文件.ts:8'] }]);
  const [link] = bufferFileLinks(b, 1, 40);
  assert.equal(link.path, 'src/文件.ts');
  assert.equal(link.line, 8);
  assert.equal(link.range.start.x, 5);
  assert.equal(link.range.end.x, 17);
});

test('soft-wrapped paths are complete on either hovered row; hard lines stay separate', () => {
  const rows = [{ chars: [...'src/long'] }, { chars: [...'/file.ts'], wrapped: true }];
  for (const y of [1, 2]) {
    const [link] = bufferFileLinks(buffer(rows), y, 8);
    assert.equal(link.path, 'src/long/file.ts');
    assert.deepEqual(link.range, { start: { x: 1, y: 1 }, end: { x: 8, y: 2 } });
  }
  assert.deepEqual(bufferFileLinks(buffer([{ chars: [...'src/long'] }, { chars: [...'/file.ts'] }]), 1, 8), []);
});

test('file open survives an unmounted files panel and is consumed exactly once by its session', () => {
  const seen: string[] = [];
  const offOpen = subscribeFileLinkOpen(req => seen.push(`open:${req.path}`));
  emitFileLink({ sessionId: 'file-test-a', path: 'src/a.ts', line: 9 });
  const wrong = subscribeFileLink('file-test-b', () => assert.fail('wrong session'));
  const off = subscribeFileLink('file-test-a', req => seen.push(`file:${req.path}:${req.line}`));
  off();
  const again = subscribeFileLink('file-test-a', () => assert.fail('request replayed'));
  assert.deepEqual(seen, ['open:src/a.ts', 'file:src/a.ts:9']);
  again(); wrong(); offOpen();
});
