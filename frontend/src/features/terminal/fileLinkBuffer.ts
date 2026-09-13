import type { IBuffer } from '@xterm/xterm';
import { matchFileLinks } from './fileLinks';

/** Map UTF-16 match offsets to actual terminal cells, including wide/combined glyphs. */
export function bufferFileLinks(buffer: Pick<IBuffer, 'getLine' | 'length'>, y: number, cols: number) {
  let first = y - 1, last = first;
  if (!buffer.getLine(first)) return [];
  // Bound pathological wrapped output; never scan the entire scrollback on hover.
  while (first > 0 && buffer.getLine(first)?.isWrapped && last - first < 64) first--;
  if (buffer.getLine(first)?.isWrapped) return [];
  while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped && last - first < 64) last++;
  if (buffer.getLine(last + 1)?.isWrapped) return [];
  let text = '';
  const starts: { x: number; y: number }[] = [], ends: { x: number; y: number }[] = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row)!;
    for (let x = 0; x < Math.min(cols, line.length); x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      // xterm can leave a padding cell before a wide glyph wraps.
      if (row < last && x === cols - 1 && !cell.getChars() && buffer.getLine(row + 1)?.getCell(0)?.getWidth() === 2) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) {
        starts.push({ x: x + 1, y: row + 1 });
        ends.push({ x: x + cell.getWidth(), y: row + 1 });
      }
    }
  }
  return matchFileLinks(text).map(m => ({
    path: m.path, line: m.line,
    range: { start: starts[m.start], end: ends[m.end - 1] },
  })).filter(m => m.range.start.y <= y && m.range.end.y >= y);
}
