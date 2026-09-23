import test from 'node:test';import assert from 'node:assert/strict';
import {claudeComposerContent,classifyClaudeComposer,createClaudeScreen} from '../src/claude-screen.ts';
const border='────────────────────────────────────────';
const lines=['Claude Code v2.1.266',border,'❯ ',border,'shift+tab to cycle'];
test('only tested empty composer authorizes input; drafts, dialogs and unknown layouts do not',()=>{
 assert.equal(classifyClaudeComposer(lines,2,2),'empty');
 assert.equal(classifyClaudeComposer([...lines.slice(0,2),'❯ handwritten',...lines.slice(3)],2,2),'terminal_draft');
 const placeholder=[...lines.slice(0,2),'❯ Try "hello"',...lines.slice(3)];
 assert.equal(classifyClaudeComposer(placeholder,2,2),'terminal_draft');assert.equal(classifyClaudeComposer(placeholder,2,2,true),'empty');
 assert.equal(classifyClaudeComposer([...lines,'Do you want to proceed?'],2,2),'dialog');
 assert.equal(classifyClaudeComposer(['shell> '],0,7),'screen_unknown');
});
test('headless state waits for parser completion and never writes query responses to a PTY',async()=>{
 const screen=createClaudeScreen(80,24);try{
 screen.write('\x1b[2J\x1b[H'+lines.join('\r\n')+'\x1b[3;3H\x1b[c',1);
 assert.equal(screen.inspect().settled,false);
 await new Promise(r=>setTimeout(r,20));assert.equal(screen.inspect().state,'empty');assert.equal(screen.inspect().seq,1);
 screen.write('draft',2);await new Promise(r=>setTimeout(r,20));assert.equal(screen.inspect().state,'terminal_draft');
 screen.resize(1000,1000);assert.equal(screen.inspect().state,'screen_unknown');
 }finally{screen.dispose();}
});

test('dim text at the input origin cannot authorize a write as an inferred suggestion',async()=>{
 const screen=createClaudeScreen(80,24);
 try{
  // Captured live shape: no cursor advance, dim foreground, arbitrary suggestion.
  // A visually identical restored draft must remain protected as well.
  screen.write('\x1b[2J\x1b[HClaude Code v2.1.266\r\n'+border+'\r\n❯ \x1b[2mcheck inbox for the reply\x1b[22m\r\n'+border+'\r\nshift+tab to cycle\x1b[3;3H',1);
  await new Promise(r=>setTimeout(r,20));
  assert.equal(screen.inspect().settled,true);
  assert.equal(screen.inspect().state,'terminal_draft');
 }finally{screen.dispose();}
});

/*
  页脚白名单漂过一次，代价是整条 GUI→TUI 静默停摆。

  2026-09-22 在 2.1.278 上实测的真实页脚是 `⏵⏵ auto mode on · 1 shell · ← 1 agent`，
  当时的白名单一条都不命中 → `screen_unknown` → 一个字节都不写，而且**不报错**。
  这里把实测到的那一行原样钉住，同时钉住「措辞再改也还认得出」这件事。
*/
test('2.1.278 的 auto mode 页脚要认得出来', () => {
  const footer = '  ⏵⏵ auto mode on · 1 shell · ← 1 agent';
  assert.equal(classifyClaudeComposer([border, '❯ ', border, footer], 1, 2), 'empty',
    '这一行在 2.1.278 上实测过；认不出来就是整条链静默停摆');
  /*
    两个标记**各自单独**都要够用，这是刻意的冗余：措辞和符号是两条独立的证据链，
    任何一条还在就不该全线静默。变异测试证明缺了这两条断言其中一条，另一条就白写了。
  */
  assert.equal(classifyClaudeComposer([border, '❯ ', border, '  ⏵⏵ 某种新模式 on'], 1, 2), 'empty',
    '措辞改了、指示符还在');
  assert.equal(classifyClaudeComposer([border, '❯ ', border, '  auto mode on · 1 shell'], 1, 2), 'empty',
    '指示符没画出来、措辞还在');
  // 草稿和对话框的判定不受影响。
  assert.equal(classifyClaudeComposer([border, '❯ 手打的字', border, footer], 1, 2), 'terminal_draft');
  assert.equal(classifyClaudeComposer([border, '❯ ', border, footer, 'Do you want to proceed?'], 1, 2), 'dialog');
  // 没有任何 Claude 迹象的画面照样不认——这条白名单的本职。
  assert.equal(classifyClaudeComposer([border, '❯ ', border, '  1 shell · 2 files'], 1, 2), 'screen_unknown');
});

/*
  画面没稳下来时 composer 必须是 null。

  上层（`ai-command-owner.ts` 的 `control()`）直接把它报给界面当 TUI 输入框的镜像，
  **靠的就是这条不变量**：没有它，界面会在解析还没跑完的半张屏上读出一段残缺的字，
  显示成「终端里现在写着 …」。变异测试发现上层那一道重复判断是死代码，判断因此挪到了
  这里——它本来就该在这儿。
*/
test('画面没稳下来时不给 composer', async () => {
 const screen = createClaudeScreen(80, 24);
 try {
  // 先让一张**带草稿**的画面稳下来。缓冲区里因此确实有内容可读——
  // 不这么铺，「没稳」那一刻缓冲区本来就是空的，两种实现读出来一样，用例白写（变异测试发现）。
  screen.write('\x1b[2J\x1b[H' + border + '\r\n❯ 已经在里面的字\r\n' + border + '\r\nshift+tab to cycle\x1b[2;3H', 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(screen.inspect().composer, '已经在里面的字');

  // 再写一段还没解析完的数据：此刻缓冲区仍然holds着上面那段字。
  screen.write('接着来的', 2);
  const pending = screen.inspect();
  assert.equal(pending.settled, false);
  assert.equal(pending.composer, null, '解析没跑完就不许报——那一刻屏上的字是旧的，报上去就是撒谎');

  await new Promise(r => setTimeout(r, 20));
  assert.equal(screen.inspect().settled, true, '稳下来之后才继续报');
 } finally { screen.dispose(); }
});

/*
  输入框不止一行。

  原来这里写死「光标行就是 ❯ 行、上下紧挨着横线」，于是只要正文换行、或者长到软换行，
  整块画面就判成「认不出」——而认不出是拒绝一切写入的。

  实测撞到：从网页发出的消息带一个 JSON 包头（`[Workspace message {…}]`），在 136 列下
  必然折行，粘进去之后回显核对永远失败，只能退回「等你自己按回车」。用户自己在终端里
  打一段长话也一样——连我们刚上线的那个「TUI 输入框镜像」都会显示成「认不出画面」。
*/
test('多行输入框：内容整框读出来', () => {
  const lines = [border, '❯ 第一行', '  第二行', '  第三行', border, '  ⏵⏵ auto mode on'];
  // 光标在最后一行内容上——原实现在这里直接返回 null。
  assert.equal(claudeComposerContent(lines, 3), '第一行\n第二行\n第三行');
  assert.equal(classifyClaudeComposer(lines, 3, 5), 'terminal_draft');
  // 光标停在提示符那一行，后面几行仍然有字：**不能判成空的**，否则会往有内容的框里写。
  assert.equal(classifyClaudeComposer(lines, 1, 2), 'terminal_draft',
    '第一行空与否都不算数，整框有内容就是草稿');
});

test('多行输入框：第一行空、后面有字，照样是草稿', () => {
  const lines = [border, '❯ ', '  用户换行之后接着打的', border, '  ⏵⏵ auto mode on'];
  assert.equal(claudeComposerContent(lines, 2), '用户换行之后接着打的');
  assert.equal(classifyClaudeComposer(lines, 1, 2), 'terminal_draft', '往这个框里写会把两段话拼一起');
});

test('框太高就不认——那不是我们验过的形状', () => {
  const tall = [border, '❯ x', ...Array.from({ length: 20 }, (_, i) => `  行${i}`), border];
  assert.equal(claudeComposerContent(tall, 21), null);
  assert.equal(classifyClaudeComposer(tall, 21, 3), 'screen_unknown');
});

test('光标不在任何输入框里时仍然认不出', () => {
  const lines = ['随便什么输出', border, '❯ ', border, '  ⏵⏵ auto mode on'];
  assert.equal(claudeComposerContent(lines, 0), null, '光标在框外，不能把下面那个框认成它的');
});

test('多行但整框没字：不算空，按不认识处理', () => {
  /*
    框有好几行、里面却一个字都没有——这不是我们验过的形状。判成 `empty` 就等于授权往里写，
    而我们并不知道那几行是什么。所以只要光标不在提示符那一行，一律当草稿（即拒绝写入）。
    这一条是**防御性**的：变异测试证明，去掉它在已知形状上看不出区别，正因如此它必须被
    单独钉住，否则下一个人会当死代码删掉。
  */
  const lines = [border, '❯ ', '   ', '   ', border, '  ⏵⏵ auto mode on'];
  assert.equal(classifyClaudeComposer(lines, 2, 2), 'terminal_draft', '不认识的形状不许授权写入');
  // 对照：同样是空的，但框只有一行——那是验过的形状，可以写。
  assert.equal(classifyClaudeComposer([border, '❯ ', border, '  ⏵⏵ auto mode on'], 1, 2), 'empty');
});

test('上下横线之间一行都没有：不是输入框', () => {
  const lines = ['x', border, border, '  ⏵⏵ auto mode on'];
  assert.equal(claudeComposerContent(lines, 1), null);
  assert.equal(classifyClaudeComposer(lines, 1, 0), 'screen_unknown');
});

test('光标正落在横线上时，不许把下面那个框当成它的', () => {
  /*
    重绘途中光标可以停在任何位置。落在边框上时，「向上找到的横线」和「向下找到的横线」
    是同一条——此时框的上下界重合，里面一行都没有。不拦住的话，`top+1` 正好是下面那个框的
    `❯` 行，于是会去读一个**光标根本不在里面**的输入框。
  */
  const lines = ['输出', border, '❯ 别人的内容', border, '  ⏵⏵ auto mode on'];
  assert.equal(claudeComposerContent(lines, 1), null, '光标在边框上，不属于任何框');
  assert.equal(classifyClaudeComposer(lines, 1, 0), 'screen_unknown');
  // 对照：光标真的在框里时照常读得出来。
  assert.equal(claudeComposerContent(lines, 2), '别人的内容');
});
