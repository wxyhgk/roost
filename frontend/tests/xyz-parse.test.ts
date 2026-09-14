import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXyz } from '../src/plugins/xyz/parse.ts';

/*
  这些用例钉的是一个真实报错：`3Dmol error: Cannot read properties of undefined
  (reading 'toUpperCase')`，出事的文件是 Tinker XYZ。

  3Dmol 2.5.5 的解析器固定 `offset = 2`（把第 2 行当注释），而 Tinker 没有注释行，
  于是整体错位一行、末尾多读一行；文件以换行结尾时那一行是空串，
  `''.split(/\s+/)` 得到 `['']`，`elem[0].toUpperCase()` 当场抛。
  它前面那道 `if (lines.length < atomCount + 2) break` 只数行数，拦不住。

  就算不炸也是错的：`tokens[0]` 在 Tinker 行里是序号不是元素，而第 5~7 列是原子类型和
  成键表，会被当成位移向量 dx/dy/dz 读进去。
*/

const plain = '3\nwater\nO 0.0 0.0 0.0\nH 0.76 0.59 0.0\nH -0.76 0.59 0.0\n';
// 真实样本的头几行（s0.xyz）：首行只有原子数，原子行是 序号 元素 x y z 类型 成键原子…
const tinker =
  '120\r\n' +
  '    1  C   -1.302935   -0.499940    0.472705    2    2    6    8\r\n' +
  '    2  C   -0.771809   -1.158927   -0.566125    2    1    3   79\r\n' +
  '    3  H    0.216439   -0.530070   -1.220141    2    2    4    9\r\n';

test('标准布局原样通过，位移向量那几列留着', () => {
  const r = parseXyz(plain)!;
  assert.equal(r.comment, 'water');
  assert.deepEqual(r.atoms.map(a => a.el), ['O', 'H', 'H']);
  assert.equal(r.model, plain);
  const vec = parseXyz('1\nvec\nO 0.0 0.0 0.0 0.1 0.2 0.3\n')!;
  assert.equal(vec.model.split('\n')[2], 'O 0.0 0.0 0.0 0.1 0.2 0.3', '重建会丢掉第 5~7 列');
});

test('Tinker 布局：元素取第二列，不是序号', () => {
  const r = parseXyz(tinker)!;
  assert.deepEqual(r.atoms.map(a => a.el), ['C', 'C', 'H'], '取成 1/2/3 就说明按标准布局读了');
  assert.equal(r.atoms.length, 3, '没有注释行，原子从第 2 行就开始');
});

test('Tinker 行必须重建成四列：序号、类型、成键表都不能漏给 3Dmol', () => {
  const body = parseXyz(tinker)!.model.split('\n').slice(2).filter(l => l !== '');
  assert.deepEqual(body, [
    'C -1.302935 -0.499940 0.472705',
    'C -0.771809 -1.158927 -0.566125',
    'H 0.216439 -0.530070 -1.220141',
  ]);
  for (const line of body) {
    assert.equal(line.split(/\s+/).length, 4,
      '超过 6 列时 3Dmol 会把第 5~7 列当成位移向量 dx/dy/dz');
  }
});

test('交给 3Dmol 的那份永远没有空行，原子数是实际数到的', () => {
  for (const src of [tinker, plain, '5\npadded\nO 0 0 0\nH 0.7 0.6 0\n\n\n']) {
    const r = parseXyz(src)!;
    const rows = r.model.split('\n').slice(2, -1);
    assert.ok(rows.every(l => l.trim()), '空行就是那个 toUpperCase 崩溃的直接原因');
    assert.equal(r.model.split('\n')[0], String(r.atoms.length), '数目虚高会让 3Dmol 读过界');
    assert.ok(!r.model.includes('\r'), '\\r 不该带给 3Dmol');
  }
});

test('原子块中间的空行跳过，后面的原子不跟着消失', () => {
  const r = parseXyz('3\nwater\nO 0.0 0.0 0.0\n\nH 0.76 0.59 0.0\n   \nH -0.76 0.59 0.0\n')!;
  assert.equal(r.atoms.length, 3);
});

test('CRLF 和纯 CR 都认', () => {
  for (const eol of ['\r\n', '\r']) {
    assert.equal(parseXyz(plain.replaceAll('\n', eol))!.atoms.length, 3, `${JSON.stringify(eol)} 没认出来`);
  }
});

test('压根不是 XYZ 的内容返回 null，让调用方回退到纯文本', () => {
  assert.equal(parseXyz(''), null);
  assert.equal(parseXyz('hello\nworld\nagain'), null, '首行不是数字');
  assert.equal(parseXyz('0\n\n'), null);
  assert.equal(parseXyz('3\ncomment\nnot an atom line\n'), null);
});
