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
