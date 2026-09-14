import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXyz } from '../src/plugins/xyz/parse.ts';

/*
  这些用例钉的是一个真实报错：3Dmol 2.5.5 的 XYZ 解析器只检查总行数够不够
  （`if (lines.length < atomCount + 2) break;`），然后无条件 `tokens[0][0].toUpperCase()`。
  原子块里混进一个空行，`''.split(/\s+/)` 得到 `['']`，`elem[0]` 是 undefined，当场抛
  「Cannot read properties of undefined (reading 'toUpperCase')」。

  所以这里产出的 model 必须保证：行都非空，且首列非空。
*/
const water = '3\nwater\nO 0.0 0.0 0.0\nH 0.76 0.59 0.0\nH -0.76 0.59 0.0\n';

test('正常文件原样通过，原子数和注释都对', () => {
  const r = parseXyz(water)!;
  assert.equal(r.comment, 'water');
  assert.deepEqual(r.atoms.map(a => a.el), ['O', 'H', 'H']);
  assert.equal(r.model, water);
});

test('原子块里的空行被跳过，后面的原子不会跟着消失', () => {
  const r = parseXyz('3\nwater\nO 0.0 0.0 0.0\n\nH 0.76 0.59 0.0\n   \nH -0.76 0.59 0.0\n')!;
  assert.equal(r.atoms.length, 3, '空行不该吃掉后面的原子');
  for (const line of r.model.split('\n').slice(2)) if (line !== '') assert.ok(line.trim(), '交给 3Dmol 的行不许是空的');
});

test('头部声明的原子数比实际多时，交出去的数目是实际数到的', () => {
  const r = parseXyz('5\npadded\nO 0.0 0.0 0.0\nH 0.76 0.59 0.0\n\n\n')!;
  assert.equal(r.atoms.length, 2);
  assert.equal(r.model.split('\n')[0], '2', '否则 3Dmol 会照着 5 去读，读到空行就炸');
});

test('CRLF 和纯 CR 都认', () => {
  for (const eol of ['\r\n', '\r']) {
    const r = parseXyz(water.replaceAll('\n', eol))!;
    assert.equal(r.atoms.length, 3, `${JSON.stringify(eol)} 换行没认出来`);
    assert.ok(!r.model.includes('\r'), '交给 3Dmol 的那份不该再带 \\r');
  }
});

test('位移向量那几列要留着（3Dmol 在 tokens.length >= 7 时会读 dx/dy/dz）', () => {
  const r = parseXyz('1\nvec\nO 0.0 0.0 0.0 0.1 0.2 0.3\n')!;
  assert.equal(r.model.split('\n')[2], 'O 0.0 0.0 0.0 0.1 0.2 0.3', '重建会丢掉第 5~7 列');
});

test('压根不是 XYZ 的内容返回 null，让调用方回退到纯文本', () => {
  assert.equal(parseXyz(''), null);
  assert.equal(parseXyz('hello\nworld\nagain'), null, '首行不是数字');
  assert.equal(parseXyz('0\n\n'), null);
  assert.equal(parseXyz('3\ncomment\nnot an atom line\n'), null, '坐标不是数');
});
