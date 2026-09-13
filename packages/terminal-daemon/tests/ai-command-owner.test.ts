import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createWorkspaceStore} from '@roost/workspace-store';import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createAiCommandOwner} from '../src/ai-command-owner.ts';import type {TerminalRuntime} from '@roost/terminal-runtime';
const border='────────────────────────────────────────';
const screen=(draft='')=>'\x1b[2J\x1b[HClaude Code v2.1.266\r\n'+border+'\r\n❯ '+draft+'\r\n'+border+'\r\nshift+tab to cycle\x1b[3;3H';
async function fixture(t:any,enabled=true){
 const dir=await mkdtemp(join(tmpdir(),'command-owner-')),path=join(dir,'transcript.jsonl');await writeFile(path,'');
 const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd:dir});
 const bridge=createAiSessionBridge({storage:store.aiSessions}),binding=bridge.bind({webSessionId:'s',terminalInstanceId:'i',cliId:'claude',nativeSessionId:'native',transcriptPath:path});
 const live={id:'s',instanceId:'i',cli:'claude',cwd:dir,pid:1};const writes:string[]=[];
 const runtime={getSession:()=>live,writeSession:(_id:string,data:string)=>{writes.push(data);}} as unknown as TerminalRuntime;
 let time=1000,seq=0;
 const owner=createAiCommandOwner({store,runtime,enabled,changed:()=>{},now:()=>time,acceptanceMs:100});owner.ensure(live);
 owner.hook('s',{event:'SessionStart',sessionId:'native',version:'2.1.266'},1);
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
test('dialog, unknown output and version mismatch keep all prompts out of the terminal',async t=>{
 const f=await fixture(t);f.owner.hook('s',{event:'SessionStart',sessionId:'native',version:'future'},2);
 assert.throws(()=>f.owner.enqueue('s',f.input()),/control_unavailable/);
 f.owner.hook('s',{event:'SessionStart',sessionId:'native',version:'2.1.266'},3);f.owner.enqueue('s',f.input());
 f.owner.output('s',{type:'output',instanceId:'i',seq:100,data:screen()+'\x1b[6;1HDo you want to proceed?\x1b[3;3H'});await new Promise(r=>setTimeout(r,15));await f.owner.pump('s');assert.equal(f.writes.length,0);
 f.owner.output('s',{type:'output',instanceId:'i',seq:101,data:'\x1b[2J\x1b[Hshell> '});await new Promise(r=>setTimeout(r,15));await f.owner.pump('s');assert.equal(f.writes.length,0);
});

test('live kill switch pauses GUI queue without blocking ordinary TUI input',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());f.owner.setSendingEnabled(false);await f.owner.pump('s');assert.equal(f.writes.length,0);
 assert.equal(f.owner.control('s').reason,'disabled');f.owner.write('s','manual');assert.deepEqual(f.writes,['manual']);
 f.advance();f.advance();f.owner.setSendingEnabled(true);await f.owner.pump('s');assert.equal(f.writes.length,2);
});
