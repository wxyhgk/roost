import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createWorkspaceStore} from '@roost/workspace-store';import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createAiCommandOwner} from '../src/ai-command-owner.ts';import type {TerminalRuntime} from '@roost/terminal-runtime';
const border='────────────────────────────────────────';
const screen=(draft='')=>'\x1b[2J\x1b[HClaude Code v2.1.266\r\n'+border+'\r\n❯ '+draft+'\r\n'+border+'\r\nshift+tab to cycle\x1b[3;3H';
// version 传 null = 这个会话从没报过版本。**不能用 undefined**：显式传 undefined 会触发默认值。
async function fixture(t:any,enabled=true,version:string|null='2.1.266'){
 const dir=await mkdtemp(join(tmpdir(),'command-owner-')),path=join(dir,'transcript.jsonl');await writeFile(path,'');
 const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd:dir});
 const bridge=createAiSessionBridge({storage:store.aiSessions}),binding=bridge.bind({webSessionId:'s',terminalInstanceId:'i',cliId:'claude',nativeSessionId:'native',transcriptPath:path});
 const live={id:'s',instanceId:'i',cli:'claude',cwd:dir,pid:1};const writes:string[]=[];
 const runtime={getSession:()=>live,writeSession:(_id:string,data:string)=>{writes.push(data);}} as unknown as TerminalRuntime;
 let time=1000,seq=0;
 const owner=createAiCommandOwner({store,runtime,enabled,changed:()=>{},now:()=>time,acceptanceMs:100});owner.ensure(live);
 // version 为 undefined 时不喂：hook 里是 `event.version ?? s.version`，喂了就清不掉。
 owner.hook('s',{event:'SessionStart',sessionId:'native',...(version===null?{}:{version})},1);
 async function display(draft=''){owner.output('s',{type:'output',instanceId:'i',seq:++seq,data:screen(draft)});await new Promise(r=>setTimeout(r,15));}
 await display();
 const input=(id='r',text='hello')=>({requestId:id,type:'submit' as const,terminalInstanceId:'i',generation:binding.generation,nativeSessionId:'native',text});
 t.after(async()=>{owner.dispose();store.close();await rm(dir,{recursive:true,force:true});});
 return {owner,store,path,writes,input,display,advance:()=>{time+=200;},bridge};
}
test('FIFO waits for TUI draft/working; one write is not accepted until a correlated hook and native user record',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());f.owner.enqueue('s',f.input('r2'));
 await f.display('user draft');await f.owner.pump('s');assert.deepEqual(f.writes,[]);
 await f.display();f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'manual'},2);
 await f.owner.pump('s');assert.deepEqual(f.writes,[]);
 f.owner.hook('s',{event:'Stop',sessionId:'native'},3);await f.owner.pump('s');
 assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~\r']);assert.equal(f.store.aiCommands.get('s','r')?.status,'awaiting_acceptance');
 await f.owner.pump('s');assert.equal(f.writes.length,1);
 await appendFile(f.path,JSON.stringify({type:'user',sessionId:'native',uuid:'user-1',message:{role:'user',content:'hello'}})+'\n');
 await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','r')?.status,'awaiting_acceptance');
 f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'hello'},4);await f.owner.pump('s');
 assert.equal(f.store.aiCommands.get('s','r')?.status,'accepted');assert.equal(f.store.aiCommands.get('s','r')?.nativeMessageId,'user-1');
 f.owner.hook('s',{event:'Stop',sessionId:'native'},5);await f.owner.pump('s');assert.equal(f.writes.length,2);
});
test('uncertain writes are never retried; late proof resolves them, while epoch changes cannot be mistaken for GUI acceptance',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());await f.owner.pump('s');f.advance();await f.owner.pump('s');
 assert.equal(f.store.aiCommands.get('s','r')?.status,'uncertain');assert.equal(f.owner.enqueue('s',f.input()).status,'uncertain');await f.owner.pump('s');assert.equal(f.writes.length,1);
 f.owner.write('s','manual');f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'hello'},2);
 await appendFile(f.path,JSON.stringify({type:'user',sessionId:'native',uuid:'manual',message:{role:'user',content:'hello'}})+'\n');await f.owner.pump('s');
 assert.equal(f.store.aiCommands.get('s','r')?.status,'uncertain');
});
test('native switch cancels queued content; old input cannot follow new identity and ordinary input wins',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());f.owner.write('s','typing');await f.owner.pump('s');assert.deepEqual(f.writes,['typing']);
 f.owner.hook('s',{event:'SessionStart',sessionId:'new-native'},2);
 assert.equal(f.store.aiCommands.get('s','r')?.status,'cancelled');assert.equal(f.store.aiCommands.get('s','r')?.text,'hello');
 assert.throws(()=>f.owner.enqueue('s',f.input('old')),/target_changed/);
});
test('feature defaults off and incompatible versions never authorize writes',async t=>{
 const f=await fixture(t,false);assert.equal(f.owner.control('s').supported,false);assert.throws(()=>f.owner.enqueue('s',f.input()),/sending_disabled/);assert.deepEqual(f.writes,[]);
});

test('cancellation before write is final, late genuine acceptance can resolve timeout and protocol replies do not claim user input',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input('cancel'));f.owner.cancel('s','cancel');await f.owner.pump('s');assert.equal(f.writes.length,0);
 f.owner.enqueue('s',f.input());await f.owner.pump('s');f.advance();await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','r')?.status,'uncertain');
 f.owner.write('s','\x1b[?1;2c');
 f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'hello'},2);
 await appendFile(f.path,JSON.stringify({type:'user',sessionId:'native',uuid:'late',message:{role:'user',content:'hello'}})+'\n');
 await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','r')?.status,'accepted');
 assert.equal(f.store.aiCommands.get('s','r')?.nativeMessageId,'late');
});
test('dialog 和认不出的画面挡住一切写入',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());
 f.owner.output('s',{type:'output',instanceId:'i',seq:100,data:screen()+'\x1b[6;1HDo you want to proceed?\x1b[3;3H'});await new Promise(r=>setTimeout(r,15));await f.owner.pump('s');assert.equal(f.writes.length,0);
 f.owner.output('s',{type:'output',instanceId:'i',seq:101,data:'\x1b[2J\x1b[Hshell> '});await new Promise(r=>setTimeout(r,15));await f.owner.pump('s');assert.equal(f.writes.length,0);
});

test('live kill switch pauses GUI queue without blocking ordinary TUI input',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());f.owner.setSendingEnabled(false);await f.owner.pump('s');assert.equal(f.writes.length,0);
 assert.equal(f.owner.control('s').reason,'disabled');f.owner.write('s','manual');assert.deepEqual(f.writes,['manual']);
 f.advance();f.advance();f.owner.setSendingEnabled(true);await f.owner.pump('s');assert.equal(f.writes.length,2);
});

/*
  P2：没有实测验证过「自动提交」的 claude 版本，正文照样放进输入框，但**不替用户按回车**。

  `\r` 是一个没有寻址的字节——它的含义完全由接收方当时的画面决定。实测过一例：codex 的
  登录界面上，一次带回车的写入真的触发了一条 OAuth 授权流程。而认清画面只能靠认 TUI 长相
  的正则，正则又只在某个版本上验过，这就是版本钉子的由来。去掉那个回车，因果链就断了。

  这条曾经是「版本不对就整个拒绝」。语义平移成「版本不对就不按回车」，钉得比原来更紧：
  原来只断言「没有写入」，现在断言「写了正文、且一个字节的回车都没有」。
*/
test('未验证的版本：正文照写，但绝不替用户按回车',async t=>{
 const f=await fixture(t);
 f.owner.hook('s',{event:'SessionStart',sessionId:'native',version:'2.1.999'},2);
 await f.display();
 f.owner.enqueue('s',f.input());
 await f.owner.pump('s');
 assert.deepEqual(f.writes,['\x1b[200~hello\x1b[201~'],'正文进去了');
 assert.ok(!f.writes[0]!.includes('\r'),`绝不能带回车：${JSON.stringify(f.writes[0])}`);
 // 诚实地说「不确定」——我们确实不知道用户会不会按、什么时候按。
 const c=f.store.aiCommands.get('s','r');
 assert.equal(c?.status,'uncertain');assert.equal(c?.reason,'awaiting_user_submit');
});

test('用户自己按下回车之后，P2 那条会自己翻成已送达',async t=>{
 // 这是 P2 不是半残的理由：uncertain 仍在 pump 的 inflight 集合里，迟到的真实证据仍然作数。
 const f=await fixture(t);
 f.owner.hook('s',{event:'SessionStart',sessionId:'native',version:'2.1.999'},2);
 await f.display();f.owner.enqueue('s',f.input());await f.owner.pump('s');
 assert.equal(f.store.aiCommands.get('s','r')?.status,'uncertain');
 // 用户按回车 → CLI 发 hook、转录落一行
 f.owner.hook('s',{event:'UserPromptSubmit',sessionId:'native',prompt:'hello'},3);
 await appendFile(f.path,JSON.stringify({type:'user',sessionId:'native',uuid:'by-user',message:{role:'user',content:'hello'}})+'\n');
 await f.owner.pump('s');
 const c=f.store.aiCommands.get('s','r');
 assert.equal(c?.status,'accepted');assert.equal(c?.nativeMessageId,'by-user');
 assert.equal(f.writes.length,1,'全程只写过一次，绝不补按回车');
});

test('探不到版本仍然整个拒绝',async t=>{
 // 版本探不到说明整条观察链根本没建起来，和「版本认得出但没验过自动提交」是两件事：
 // 前者我们对这个终端一无所知，后者只是不敢替用户按最后那一下。
 const f=await fixture(t,true,null);
 assert.throws(()=>f.owner.enqueue('s',f.input()),/control_unavailable/);
});
