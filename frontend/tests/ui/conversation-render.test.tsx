/*
  真的渲染一遍对话条目。

  **这一层接住的是别的测试接不住的那一类：数据全都在，面板却不显示。** 2026-09-23 实测撞到
  一次——用户在终端里打的话、从网页发过去的话，库里、接口里、实时流里全都有，而人在界面上
  看不到自己的消息。当时仓库里一个组件测试都没有，只能靠人反复去看。

  不需要浏览器：`renderToString` 只跑渲染，不跑副作用，所以这里测的是**结构**——
  哪些内容会出现在 HTML 里、标成谁说的。样式和交互不在这一层的职责内。

  走的是真管道：HistoryMessage → groupMessages → buildItems → TranscriptItem，
  和界面上那条一模一样。手捏 Item 会绕过分组那一段，而分组正是最容易把消息吃掉的地方。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { buildItems, groupMessages } from '../../src/features/conversations/parts';
import { TranscriptItem } from '../../src/features/conversations/ConversationDetail';
import { ThemeProvider } from '../../src/shared/theme';
import type { HistoryMessage } from '../../src/shared/api/conversationPayloads';
import { t } from '@roost/i18n';

let seq = 0;
const message = (role: string, content: string): HistoryMessage => {
  seq += 1;
  return { messageId: `m${seq}`, historySeq: seq,
    event: { eventId: `e${seq}`, type: 'message', role, content, createdAt: 1_700_000_000_000 + seq } } as never;
};

function render(messages: HistoryMessage[]): string {
  const items = buildItems(groupMessages(messages));
  assert.ok(items.length > 0, '分组之后一条都不剩——消息在渲染之前就被吃掉了');
  return items.map(one).join('\n');
}

/*
  条目要放在 `ThemeProvider` 里渲染：代码高亮那一段要读当前主题，拿不到就直接抛。
  套上它比在测试里去掉高亮好——**测的应该是界面真实的样子**，不是一个为了好测而裁过的版本。
*/
const one = (item: Parameters<typeof TranscriptItem>[0]['item']) =>
  renderToString(createElement(ThemeProvider, null, createElement(TranscriptItem, { item, showRole: true })));

test('用户自己说的话要出现在对话里，而且署名是自己', () => {
  const html = render([
    message('user', '我在终端里打的这句话'),
    message('assistant', '这是我的回复'),
  ]);
  assert.match(html, /我在终端里打的这句话/, '用户消息不显示——这正是那次实测撞到的毛病');
  assert.match(html, /这是我的回复/);
  /*
    **光有正文不够，署名也要对。** 角色被弄坏时消息照样渲染，只是标成了别人说的——
    变异测试证明：只断言文字出现，把 user 角色整个换掉也一条都不红。
  */
  const labels = t.misc.conversations.detail;
  assert.match(html, new RegExp(labels.roleUser), '用户那条没有标成「自己」');
  assert.match(html, new RegExp(labels.roleAssistant), 'agent 那条没有标成 agent');
});

test('从网页发过去的那条，正文要看得见', () => {
  // 走这条路的消息带一个机器包头，正文在第二行。**包头难看不要紧，正文丢了才要命。**
  const html = render([message('user',
    '[Workspace message {"type":"agent-message","messageId":"abc","senderKind":"user"}]\n后续可以做什么')]);
  assert.match(html, /后续可以做什么/, '带包头的消息不能把正文吞掉');
});

test('三种角色都渲染，一种都不能被静默丢掉', () => {
  const html = render([
    message('user', '甲说的话'),
    message('assistant', '乙说的话'),
    message('tool', '丙的输出'),
  ]);
  for (const text of ['甲说的话', '乙说的话', '丙的输出'])
    assert.match(html, new RegExp(text), `${text} 没渲染出来`);
});

test('空正文不该渲染成一个空条目', () => {
  // 只有空白的消息在分组时就该被丢掉，而不是在界面上留一个空气泡。
  const items = buildItems(groupMessages([message('user', '   '), message('user', '真正的内容')]));
  const html = items.map(one).join('\n');
  assert.match(html, /真正的内容/);
  assert.equal(items.length, 1, '空白消息不该变成一个条目');
});
