import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Socket } from 'node:net';
import { read, MAX_IPC_BYTES } from '../src/wire.ts';

/** 只给 read() 用的假 socket：它需要 setEncoding / on / destroyed / destroy。 */
function fakeSocket() {
  const stream = new PassThrough() as unknown as Socket & { destroyedBy?: boolean };
  let destroyed = false;
  Object.defineProperty(stream, 'destroyed', { get: () => destroyed, configurable: true });
  stream.destroy = (() => { destroyed = true; return stream; }) as Socket['destroy'];
  return { stream, wasDestroyed: () => destroyed };
}

function collect(chunks: string[]) {
  const { stream, wasDestroyed } = fakeSocket();
  const seen: unknown[] = [];
  read(stream, (message) => seen.push(message));
  for (const chunk of chunks) stream.emit('data', chunk);
  return { seen, wasDestroyed };
}

test('一帧跨多片时仍然完整还原，切在哪儿都一样', () => {
  const message = { type: 'output', data: 'x'.repeat(5000) };
  const line = JSON.stringify(message) + '\n';
  for (const size of [1, 7, 64, 1024, line.length - 1, line.length]) {
    const chunks: string[] = [];
    for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size));
    const { seen, wasDestroyed } = collect(chunks);
    assert.equal(wasDestroyed(), false, `切片 ${size} 不该断连`);
    assert.deepEqual(seen, [message], `切片 ${size} 应还原出同一条消息`);
  }
});

test('一片里有多条、以及半条留到下一片', () => {
  const a = JSON.stringify({ n: 1 }), b = JSON.stringify({ n: 2 }), c = JSON.stringify({ n: 3 });
  const { seen, wasDestroyed } = collect([`${a}\n${b}\n${c.slice(0, 3)}`, `${c.slice(3)}\n`]);
  assert.equal(wasDestroyed(), false);
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

/*
  字节数是增量维护的（加按片、减按行），不再每片重数整段。

  多字节字符是这个改动最容易出错的地方：一旦累加的结果和真实 UTF-8 字节数对不上，
  上限判断就会提前掐连接或者根本不掐。`setEncoding('utf8')` 保证收到的是完整解码的
  字符串，所以两者必须相等——这里把它钉死。
*/
test('多字节字符跨片时，字节记账仍然准确', () => {
  // 故意让一个 4 字节 emoji 落在片边界上
  const message = { s: '中文😀'.repeat(300) };
  const line = JSON.stringify(message) + '\n';
  const encoder = new TextEncoder();
  const raw = encoder.encode(line);
  // 按**字节**切，制造半个字符的片，交给 StringDecoder 去拼
  const { stream, wasDestroyed } = fakeSocket();
  const seen: unknown[] = [];
  read(stream, (m) => seen.push(m));
  const decoder = new StringDecoder('utf8');
  for (let i = 0; i < raw.length; i += 13) {
    const text = decoder.write(Buffer.from(raw.slice(i, i + 13)));
    if (text) stream.emit('data', text);
  }
  assert.equal(wasDestroyed(), false);
  assert.deepEqual(seen, [message]);
});

test('超过上限的单行掐掉连接，正常大小的不掐', () => {
  const big = JSON.stringify({ s: 'x'.repeat(MAX_IPC_BYTES) }) + '\n';
  assert.equal(collect([big]).wasDestroyed(), true, '超限单行必须掐');

  const ok = JSON.stringify({ s: 'x'.repeat(1000) }) + '\n';
  assert.equal(collect([ok]).wasDestroyed(), false);
});

test('没有换行的积压超过上限也要掐，否则内存无界', () => {
  const { stream, wasDestroyed } = fakeSocket();
  read(stream, () => {});
  // 一直发不带换行的内容
  for (let i = 0; i < 40 && !wasDestroyed(); i++) stream.emit('data', 'x'.repeat(128 * 1024));
  assert.equal(wasDestroyed(), true);
});

test('坏 JSON 掐连接，不把异常抛给调用方', () => {
  assert.equal(collect(['{not json}\n']).wasDestroyed(), true);
});
