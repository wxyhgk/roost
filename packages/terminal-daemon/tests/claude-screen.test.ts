import test from 'node:test';import assert from 'node:assert/strict';
import {classifyClaudeComposer,createClaudeScreen} from '../src/claude-screen.ts';
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
