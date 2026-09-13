import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import type {TerminalRuntime} from '@roost/terminal-runtime';
import {createAiCommandOwner} from '../src/ai-command-owner.ts';

async function fixture(t:any,enabled=true){
 const dir=await mkdtemp(join(tmpdir(),'qwen-command-owner-'));
 const transcriptPath=join(dir,'native.jsonl'),inputPath=join(dir,'input.jsonl');
 await Promise.all([writeFile(transcriptPath,''),writeFile(inputPath,'')]);
 const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd:dir});
 const bridge=createAiSessionBridge({storage:store.aiSessions});
 const binding=bridge.bind({webSessionId:'s',terminalInstanceId:'i',cliId:'qwen',nativeSessionId:'native',transcriptPath});
 const live={id:'s',instanceId:'i',cli:'qwen',cwd:dir,pid:1};const writes:string[]=[];
 const runtime={getSession:()=>live,writeSession:(_id:string,data:string)=>writes.push(data)} as unknown as TerminalRuntime;
 let now=1000,seq=0;
 const owner=createAiCommandOwner({store,runtime,enabled:false,qwenEnabled:enabled,changed:()=>{},now:()=>now,acceptanceMs:100});owner.ensure(live);
 function hook(event:string,prompt?:string,extra:Record<string,unknown>={}){owner.qwenHook('s',{event,sessionId:'native',inputPath,version:'0.23.1',protocolVersion:2,lifecycleSupported:true,prompt,...extra},++seq);}
 hook('SessionStart');
 const input=(requestId='r',text='hello')=>({requestId,type:'submit' as const,terminalInstanceId:'i',generation:binding.generation,nativeSessionId:'native',text});
 const native=async(uuid:string,text='hello',extra:Record<string,unknown>={})=>appendFile(transcriptPath,JSON.stringify({type:'user',sessionId:'native',uuid,provenance:'real_user',message:{role:'user',parts:[{text}]},...extra})+'\n');
 const submitted=async()=>{const text=await readFile(inputPath,'utf8');return text.trim()?text.trim().split('\n').map(line=>JSON.parse(line)):[];};
 t.after(async()=>{owner.dispose();store.close();await rm(dir,{recursive:true,force:true});});
 return {owner,store,input,hook,native,submitted,writes,advance:()=>{now+=500;}};
}

test('Qwen uses native input without composer keys; FIFO requires both structured hook and a new durable real-user record',async t=>{
 const f=await fixture(t);assert.equal(f.owner.control('s').supported,true);
 f.owner.enqueue('s',f.input());f.owner.enqueue('s',f.input('second'));
 await f.owner.pump('s');assert.deepEqual(await f.submitted(),[{type:'submit',text:'hello'}]);assert.deepEqual(f.writes,[]);
 await f.native('before-hook');await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','r')?.status,'awaiting_acceptance');
 f.hook('UserPromptSubmit','hello');await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','r')?.status,'accepted');assert.equal(f.store.aiCommands.get('s','r')?.nativeMessageId,'before-hook');
 await f.owner.pump('s');assert.equal((await f.submitted()).length,1);
 f.hook('Stop');await f.owner.pump('s');assert.equal((await f.submitted()).length,2);
 f.hook('UserPromptSubmit','hello');await f.native('second-native');await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','second')?.nativeMessageId,'second-native');
});

test('Qwen never takes a TUI user message or synthetic background row as GUI acceptance and never retries uncertain delivery',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());await f.owner.pump('s');
 f.hook('UserPromptSubmit','hello');await f.native('background','hello',{provenance:'background_agent'});await f.owner.pump('s');assert.equal(f.store.aiCommands.get('s','r')?.status,'awaiting_acceptance');
 f.owner.write('s','manual draft');await f.native('manual');f.advance();await f.owner.pump('s');
 assert.equal(f.store.aiCommands.get('s','r')?.status,'uncertain');assert.equal(f.owner.enqueue('s',f.input()).status,'uncertain');await f.owner.pump('s');assert.equal((await f.submitted()).length,1);assert.deepEqual(f.writes,['manual draft']);
});

test('Qwen permission and recent TUI input pause native submissions; CLI exit cancels the queue with text retained',async t=>{
 const f=await fixture(t);f.owner.enqueue('s',f.input());f.hook('PermissionRequest');await f.owner.pump('s');assert.equal(f.owner.control('s').reason,'dialog');assert.deepEqual(await f.submitted(),[]);
 f.hook('Stop');f.owner.write('s','draft');await f.owner.pump('s');assert.deepEqual(await f.submitted(),[]);
 f.hook('SessionEnd');assert.equal(f.store.aiCommands.get('s','r')?.status,'cancelled');assert.equal(f.store.aiCommands.get('s','r')?.text,'hello');assert.equal(f.owner.control('s').supported,false);
});

test('Qwen needs its own feature flag and tested protocol and rejects whitespace that native submission would trim',async t=>{
 const f=await fixture(t,false);assert.equal(f.owner.control('s').supported,false);assert.throws(()=>f.owner.enqueue('s',f.input()),/sending_disabled/);
 const g=await fixture(t);assert.throws(()=>g.owner.enqueue('s',g.input('trim',' hello ')),/invalid_request/);
 g.hook('SessionStart',undefined,{version:'future'});assert.equal(g.owner.control('s').supported,false);assert.throws(()=>g.owner.enqueue('s',g.input()),/control_unavailable/);
});


test('native input alone does not advertise usable Qwen sending without a verified complete lifecycle source',async t=>{
 const f=await fixture(t);f.hook('SessionStart',undefined,{lifecycleSupported:false});
 assert.equal(f.owner.control('s').supported,false);assert.equal(f.owner.control('s').reason,'lifecycle_unavailable');
 assert.throws(()=>f.owner.enqueue('s',f.input()),/control_unavailable/);assert.deepEqual(await f.submitted(),[]);
});


test('Qwen without an exact transcript path cannot accept a first GUI request into a permanently blocked queue',async t=>{
 const f=await fixture(t);const record=f.store.aiSessions.list()[0];delete record.binding.transcriptPath;f.store.aiSessions.save(record,record.binding.revision);
 assert.equal(f.owner.control('s').supported,false);assert.equal(f.owner.control('s').reason,'transcript_unavailable');
 assert.throws(()=>f.owner.enqueue('s',f.input()),/control_unavailable/);assert.equal(f.store.aiCommands.active('s').length,0);
});
