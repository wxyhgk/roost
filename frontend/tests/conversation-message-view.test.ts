import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldsWhenLong, messageView, type MessageView } from '../src/features/conversations/message-view.ts';

/*
  分派的守卫。

  钉的不是「三个角色映射到三个字符串」这种同义反复，而是**换掉 TextBlock 之后行为没变**：
  以前那两个布尔散在 className 的模板串里，改动它们不会让任何测试变红。现在它们是一个
  函数，而这个文件把旧的判据原样写了一遍，两边必须逐个角色对得上。

  这里只测 `.ts`：`frontend/tests` 没有 jsdom，而 `MessageBody.tsx` 一路 import 到
  `MessageItem.module.css`，`node --test` 加载不了 CSS Module。所以要被测的判断都放在
  message-view.ts 里，那个文件零 import。
*/

/** 换掉之前 ConversationDetail.tsx 的 TextBlock 里那两行，原样抄来当参照。 */
const oldMine = (role: string) => role === 'user';
const oldProse = (role: string) => !oldMine(role) && role !== 'tool';

/* 真实数据里出现过的，加上生面孔和空串。角色是个开放集合，解析器给什么就是什么。 */
const ROLES = ['user', 'assistant', 'tool', 'system', 'developer', 'Assistant', '', 'user '];

test('三种画法和旧的 TextBlock 判据逐个角色等价', () => {
  for (const role of ROLES) {
    const view = messageView(role);
    assert.equal(view === 'bubble', oldMine(role), `${JSON.stringify(role)} 的气泡判据变了`);
    assert.equal(view === 'prose', oldProse(role), `${JSON.stringify(role)} 的正文判据变了`);
    assert.equal(view === 'mono', !oldMine(role) && role === 'tool', `${JSON.stringify(role)} 的等宽判据变了`);
  }
});

test('认不出来的角色走正文，不走气泡', () => {
  // 倒向气泡会让一条不是用户说的话顶着「你」的样子出现在右边，那比多排一次版糟得多。
  for (const role of ['system', 'developer', 'Assistant', '', 'user ', 'tool_result']) {
    assert.equal(messageView(role), 'prose');
  }
});

test('大小写和空白不做归一化', () => {
  // 解析器给的角色是逐字的；在这里做 trim/toLowerCase 等于替上游猜，猜错了没人看得见。
  assert.equal(messageView('User'), 'prose');
  assert.equal(messageView(' user'), 'prose');
  assert.equal(messageView('TOOL'), 'prose');
});

test('只有等宽那一支折叠长文', () => {
  const views: MessageView[] = ['bubble', 'prose', 'mono'];
  assert.deepEqual(views.map(foldsWhenLong), [false, false, true]);
});
