/*
  TUI 输入框的镜像。

  这几格的区别全是语义上的，而**合并任意两格都会让界面在关键时刻撒谎**：
  把「认不出画面」显示成「空着」，用户会以为对面一切正常，其实我们瞎了；
  把 `supported:false` 显示成「可以写入」，用户会一直按发送，而那条通道压根没开。

  所以这里逐格钉。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorBlock, mirrorContent } from '../src/features/conversations/tuiMirror';
import type { AiControl } from '../src/shared/api/conversations';

const control = (patch: Partial<AiControl> = {}): AiControl =>
  ({ supported: true, reason: null, inputEpoch: 0, composer: '', ...patch });

test('认不出画面和空输入框是两件事', () => {
  assert.deepEqual(mirrorContent(control({ composer: null })), { kind: 'unknown' },
    'null 是「不知道」，绝不能显示成「空着」');
  assert.deepEqual(mirrorContent(control({ composer: '' })), { kind: 'empty' });
  // 只有空白也算空：画面里那一行常常带着补白空格。
  assert.deepEqual(mirrorContent(control({ composer: '   ' })), { kind: 'empty' });
});

test('输入框里有字就原样照出来，不声称是谁打的', () => {
  assert.deepEqual(mirrorContent(control({ composer: '  后续可以做什么  ' })),
    { kind: 'draft', text: '后续可以做什么' });
  // claude 把多行粘贴折叠成这种标记，照样原样显示——它确实就是屏幕上的样子。
  assert.deepEqual(mirrorContent(control({ composer: '[Pasted text #1 +4 lines]' })),
    { kind: 'draft', text: '[Pasted text #1 +4 lines]' });
});

test('通道没开和此刻不该写，都不是「可以写入」', () => {
  assert.equal(mirrorBlock(control()), null, '通道开着又没有原因，才是可以写');
  assert.equal(mirrorBlock(control({ reason: 'busy' })), 'busy');
  // supported:false 且没给原因——仍然必须挡住，不能因为 reason 是 null 就说可以写。
  assert.equal(mirrorBlock(control({ supported: false, reason: null })), 'unsupported_cli');
  // 通道没开但给了原因时，说那个具体原因，别用兜底盖掉它。
  assert.equal(mirrorBlock(control({ supported: false, reason: 'disabled' })), 'disabled');
});
