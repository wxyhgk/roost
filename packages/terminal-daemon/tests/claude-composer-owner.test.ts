import test from 'node:test';
import assert from 'node:assert/strict';
import { composerHoldsPrompt, pastedMarkerLineCount } from '../src/claude-composer-owner.ts';

/*
  P2 之后我们自己的正文留在输入框里。画面上它和用户自己打的字长得一模一样——
  分不出来就会用「终端输入框里还有草稿」去怪用户，而那段草稿是我们放的。
*/
test('原样显示的短消息认得出', () => {
  assert.equal(composerHoldsPrompt('看看当前的项目', '看看当前的项目'), true);
  assert.equal(composerHoldsPrompt('看看当前的项目', '别的话'), false);
});

test('多行粘贴的折叠标记认得出 —— 实测 2.1.273 的形状', () => {
  // 粘 5 行（4 个换行）→ [Pasted text #1 +4 lines]。数字等于换行数。
  const prompt = 'first\nsecond\nthird\nfourth\nfifth';
  assert.equal(composerHoldsPrompt('[Pasted text #1 +4 lines]', prompt), true);
  assert.equal(pastedMarkerLineCount('[Pasted text #1 +4 lines]'), 4);
});

test('计数用区间不用相等 —— claude 怎么数行没有承诺', () => {
  const prompt = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';   // 9 个换行
  for (const n of [7, 8, 9, 10, 11, 12]) {
    assert.equal(composerHoldsPrompt(`[Pasted text +${n} lines]`, prompt), true, `${n} 应在区间内`);
  }
  assert.equal(composerHoldsPrompt('[Pasted text +2 lines]', prompt), false, '差太远就不是我们那条');
  assert.equal(composerHoldsPrompt('[Pasted text +40 lines]', prompt), false);
});

test('省掉计数的标记也认 —— 足够大的单行粘贴 claude 会省', () => {
  assert.equal(composerHoldsPrompt('[Pasted text #1]', 'x'.repeat(5000)), true);
  assert.equal(composerHoldsPrompt('[Pasted text]', 'anything'), true);
});

test('认不出画面、或输入框空着时一律 false', () => {
  assert.equal(composerHoldsPrompt(null, 'hello'), false, '认不出画面');
  assert.equal(composerHoldsPrompt('', 'hello'), false, '输入框空着');
  assert.equal(composerHoldsPrompt('hello', ''), false, '我们没有待定的正文');
});

test('用户自己打的字不会被认成我们的', () => {
  assert.equal(composerHoldsPrompt('用户自己在打字', '我们要发的话'), false);
  // 长得像标记但不是完整形状的，不认。
  assert.equal(composerHoldsPrompt('看看 [Pasted text +4 lines] 这个', 'a\nb\nc\nd\ne'), false);
});

/*
  软换行和真换行在屏幕上分不开。

  从网页发出的消息带一个 JSON 包头，在 136 列的终端里必然折行：原文里那儿没有换行，
  读回来却是两行。反过来原文里的换行在屏幕上也是换行。没有任何办法从画面上区分，
  所以比对时把空白整个抹掉。

  这不算放宽：同一个函数已经接受「`[Pasted text #1]` 就算数」那条更松的路。
*/
test('折行之后读回来的正文仍然认得出是自己那条', () => {
  const prompt = '[Workspace message {"type":"agent-message","messageId":"b13c0e20"}]\n后续可以做什么';
  // 屏幕上：包头折成两行，正文自己一行。
  const onScreen = '[Workspace message {"type":"agent-message",\n"messageId":"b13c0e20"}]\n后续可以做什么';
  assert.equal(composerHoldsPrompt(onScreen, prompt), true);
});

test('抹掉空白之后，别人的正文还是不认', () => {
  assert.equal(composerHoldsPrompt('用户自己打的另一句话', '我们放进去的那一句'), false);
  assert.equal(composerHoldsPrompt('后续可以做什么了', '后续可以做什么'), false, '多一个字就不是同一条');
});
