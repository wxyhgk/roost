import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachTuiIme } from '../src/features/terminal/ime';

test('composition anchor stays inside resized grid and returns to live cursor after composition', t => {
  const oldRequest = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => { globalThis.requestAnimationFrame = oldRequest; globalThis.cancelAnimationFrame = oldCancel; });
  function element() {
    const values = new Map<string, string>();
    const target = Object.assign(new EventTarget(), { classList: { add() {}, remove() {} }, style: {
      setProperty(key: string, value: string) { values.set(key, value); }, removeProperty(key: string) { values.delete(key); },
    } });
    return { target: target as unknown as HTMLTextAreaElement, values };
  }
  const textarea = element(), view = element();
  let cols = 100, rows = 30;
  const buffer = { cursorX: 90, cursorY: 25, getLine: () => undefined };
  const detach = attachTuiIme({ root: textarea.target, textarea: textarea.target, compositionView: view.target,
    cols: () => cols, rows: () => rows, buffer: () => buffer,
    origin: () => ({ left: 20, top: 40, width: cols * 10, height: rows * 20 } as DOMRect), mode: 'fixed' });
  textarea.target.dispatchEvent(new Event('compositionstart'));
  assert.equal(textarea.values.get('--ime-left'), '920px');
  cols = 40; rows = 10;
  textarea.target.dispatchEvent(new Event('compositionupdate'));
  assert.equal(textarea.values.get('--ime-left'), '410px');
  assert.equal(textarea.values.get('--ime-top'), '220px');
  assert.equal(view.values.get('--ime-left'), '410px');
  textarea.target.dispatchEvent(new Event('compositionend'));
  buffer.cursorX = 2; buffer.cursorY = 1;
  textarea.target.dispatchEvent(new Event('focus'));
  assert.equal(textarea.values.get('--ime-left'), '40px');
  assert.equal(textarea.values.get('--ime-top'), '60px');
  detach();
  assert.equal(textarea.values.size, 0);
});
