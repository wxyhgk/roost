import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import type {TerminalService} from '@roost/terminal-runtime';
import type {AgentEvent} from '@roost/terminal-protocol';
import {createAiAgentSource} from '../src/ai-agent-source.ts';

type Entry={terminalInstanceId:string;sourceSeq:number;agent:AgentEvent};
type Page={events:Entry[];cursor:number;highWater:number;more:boolean;hasGap:boolean};
const event=(seq:number,cli:string,native:string,response?:string):Entry=>({terminalInstanceId:'same-pty',sourceSeq:seq,agent:{agent:cli,sessionId:native,event:response===undefined?'session_start':'stop',...(response===undefined?{}:{response})}});
function fixture(initialCli='opencode'){
 const dir=mkdtempSync(join(tmpdir(),'ai-cli-switch-')),store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'web',cwd:dir});
 let bridge=createAiSessionBridge({storage:store.aiSessions});
 const first=bridge.bind({webSessionId:'web',terminalInstanceId:'same-pty',cliId:initialCli,nativeSessionId:'native-shared',transcriptPath:'/synthetic/opencode/old.jsonl'});
 bridge.publish('web',{eventId:'same-pty:1',type:'message',role:'assistant',content:'saved OpenCode answer'},{cursor:1,hasGap:false});
 let cli=initialCli,enabled=false,readCount=0,rebound=0;
 let page:Page={events:[],cursor:1,highWater:1,more:false,hasGap:false};let beforeReturn:(()=>void)|undefined;
 const runtime={getSession:()=>({id:'web',cwd:dir,pid:1,instanceId:'same-pty',cli}),isConnected:()=>true,supportsAgentReplay:()=>enabled,
  readAgentEvents:async(_id:string,_instance:string,after:number)=>{readCount++;beforeReturn?.();return {...page,events:page.events.filter(e=>e.sourceSeq>after)};},subscribe:()=>()=>{},scanLiveSessions:async()=>{}} as unknown as TerminalService;
 let source=createAiAgentSource(store,runtime,bridge,()=>{rebound++;});enabled=true;
 return {dir,runtime,store,get bridge(){return bridge;},first,get source(){return source;},restartSource:()=>{enabled=false;source.dispose();source=createAiAgentSource(store,runtime,bridge,()=>{rebound++;});enabled=true;},restoreBridge:()=>{enabled=false;source.dispose();bridge=createAiSessionBridge({storage:store.aiSessions});source=createAiAgentSource(store,runtime,bridge,()=>{rebound++;});enabled=true;},setCli:(value:string)=>{cli=value;},setPage:(events:Entry[],gap=false)=>{const high=events.at(-1)?.sourceSeq??bridge.source('web').cursor;page={events,cursor:high,highWater:high,more:false,hasGap:gap};},onRead:(callback:()=>void)=>{beforeReturn=callback;},readCount:()=>readCount,rebound:()=>rebound,
  close:()=>{source.dispose();store.close();rmSync(dir,{recursive:true,force:true});}};
}
const contents=(f:ReturnType<typeof fixture>)=>f.bridge.read('web').events.filter(x=>x.event.type==='message').map(x=>x.event.content);

test('same PTY OpenCode to omp uses a new CLI identity even when native session strings coincide and preserves old durable history',async()=>{
 const f=fixture();try{
  const boundary=event(2,'omp','native-shared');boundary.agent.transcriptPath='/synthetic/omp/new.jsonl';f.setCli('omp');f.setPage([boundary,event(3,'omp','native-shared','new omp answer')]);await f.source.catchUp('web');
  assert.equal(f.bridge.get('web')?.cliId,'omp');assert.equal(f.bridge.get('web')?.nativeSessionId,'native-shared');assert.equal(f.bridge.get('web')?.terminalInstanceId,'same-pty');assert.notEqual(f.bridge.get('web')?.generation,f.first.generation);
  assert.deepEqual(contents(f),['new omp answer']);assert.equal(f.rebound(),1);assert.equal(f.bridge.get('web')?.transcriptPath,'/synthetic/omp/new.jsonl');
  const late=event(4,'opencode','native-shared','wrong same-id old answer');late.agent.transcriptPath='/synthetic/opencode/late.jsonl';f.setPage([late]);await f.source.catchUp('web');assert.equal(f.bridge.get('web')?.transcriptPath,'/synthetic/omp/new.jsonl');assert.deepEqual(contents(f),['new omp answer']);
  assert.deepEqual(f.store.aiSessions.history!.pageMessages('web',f.first.generation).items.map(x=>x.event.content),['saved OpenCode answer']);
  const catalog=f.store.conversations.list({state:'all'}).items;assert.equal(catalog.length,2);assert.equal(new Set(catalog.map(x=>x.id)).size,2);assert.deepEqual(catalog.map(x=>x.source.cliId).sort(),['omp','opencode']);
 }finally{f.close();}
});

test('ordered cross CLI switch skips queued old CLI events and later old callbacks without rebinding or mixing messages',async()=>{
 const f=fixture();try{
  f.setCli('omp');f.setPage([event(2,'opencode','native-shared','late old answer'),event(3,'omp','omp-native'),event(4,'omp','omp-native','omp first')]);await f.source.catchUp('web');
  assert.equal(f.bridge.get('web')?.cliId,'omp');assert.equal(f.bridge.get('web')?.nativeSessionId,'omp-native');assert.deepEqual(contents(f),['omp first']);const generation=f.bridge.get('web')!.generation;
  f.setPage([event(5,'opencode','native-shared','later old callback'),event(6,'omp','omp-native','omp second')]);await f.source.catchUp('web');
  assert.equal(f.bridge.get('web')?.generation,generation);assert.equal(f.bridge.get('web')?.cliId,'omp');assert.deepEqual(contents(f),['omp first','omp second']);assert.equal(f.bridge.source('web').cursor,6);assert.equal(f.rebound(),1);
  assert.deepEqual(f.store.aiSessions.history!.pageMessages('web',f.first.generation).items.map(x=>x.event.content),['saved OpenCode answer']);
 }finally{f.close();}
});

test('cross CLI replay gap or runtime CLI drift while a page is pending leaves old history and identity intact',async()=>{
 for(const mode of ['gap','drift'] as const){const f=fixture();try{
  f.setCli('omp');f.setPage([event(2,'omp','omp-native')],mode==='gap');if(mode==='drift')f.onRead(()=>f.setCli('claude'));
  await f.source.catchUp('web');assert.equal(f.bridge.get('web')?.generation,f.first.generation);assert.equal(f.bridge.get('web')?.cliId,'opencode');assert.equal(f.bridge.source('web').cursor,1);assert.equal(f.rebound(),0);assert.deepEqual(contents(f),['saved OpenCode answer']);
  assert.ok(f.readCount()>0,'cross CLI journal must actually be inspected, not silently blocked before reading');
  if(mode==='gap')assert.equal(f.source.status('web').hasGap,true);
 }finally{f.close();}}
});

test('unattributed legacy events cannot establish a cross CLI identity or move the old history into the current CLI',async()=>{
 const f=fixture();try{
  const unattributed=event(2,'omp','legacy-native');delete unattributed.agent.agent;
  f.setCli('omp');f.setPage([unattributed]);await f.source.catchUp('web');
  assert.equal(f.bridge.get('web')?.cliId,'opencode');assert.equal(f.bridge.get('web')?.generation,f.first.generation);assert.equal(f.rebound(),0);assert.deepEqual(contents(f),['saved OpenCode answer']);
  assert.equal(f.store.conversations.list({state:'all'}).items.length,1);
 }finally{f.close();}
});

test('cross CLI adoption closes the old websocket and reconnect returns only the new generation', {timeout:6000},async()=>{
 const {once}=await import('node:events');const {WebSocket}=await import('ws');const {createBackendServer}=await import('../src/server.ts');
 const f=fixture();f.source.dispose();const server=createBackendServer({ auth: false,store:f.store,runtime:f.runtime,sessionBridge:f.bridge,workspaceRoot:f.dir});const sockets:InstanceType<typeof WebSocket>[]=[];
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const connect=async()=>{const ws=new WebSocket(base.replace('http:','ws:')+'/api/ai-sessions/web/events?afterSeq=0');sockets.push(ws);const [data]=await once(ws,'message',{signal:AbortSignal.timeout(2500)});return{ws,snapshot:JSON.parse(data.toString())};};
  const old=await connect();assert.equal(old.snapshot.binding.cliId,'opencode');
  const closed=once(old.ws,'close',{signal:AbortSignal.timeout(2500)});
  f.setCli('omp');f.setPage([event(2,'omp','omp-native'),event(3,'omp','omp-native','new visible omp reply')]);
  assert.equal((await closed)[0],1008);const current=await connect();assert.equal(current.snapshot.binding.cliId,'omp');assert.notEqual(current.snapshot.binding.generation,f.first.generation);
  assert.deepEqual(current.snapshot.events.filter((x:any)=>x.event.type==='message').map((x:any)=>x.event.content),['new visible omp reply']);
  const saved=await fetch(base+'/api/ai-sessions/web/generations/'+f.first.generation+'/messages');assert.equal(saved.status,200);assert.deepEqual((await saved.json()).items.map((x:any)=>x.event.content),['saved OpenCode answer']);
 }finally{for(const ws of sockets)ws.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});

for(const mode of ['same-page','later-page','source-recreation','sqlite-bridge-restoration'] as const)test(`unattributed old identity cannot poison an explicit cross CLI generation (${mode})`,async()=>{
 const f=fixture();try{
  f.setCli('omp');const late=event(4,'opencode','old-late','foreign unlabelled reply');delete late.agent.agent;
  const initial=[event(2,'omp','omp-native'),event(3,'omp','omp-native','correct omp answer')];
  f.setPage(mode==='same-page'?[...initial,late]:initial);await f.source.catchUp('web');
  if(mode!=='same-page'){if(mode==='source-recreation')f.restartSource();if(mode==='sqlite-bridge-restoration'){f.restoreBridge();assert.equal(f.bridge.source('web').requiresCli,true);}f.setPage([late]);await f.source.catchUp('web');}
  assert.equal(f.bridge.get('web')?.cliId,'omp');assert.equal(f.bridge.get('web')?.nativeSessionId,'omp-native');assert.equal(f.rebound(),1);assert.deepEqual(contents(f),['correct omp answer']);
  assert.deepEqual(f.store.aiSessions.history!.pageMessages('web',f.first.generation).items.map(x=>x.event.content),['saved OpenCode answer']);
 }finally{f.close();}
});

test('an unknown event after a verified CLI boundary cannot change identity, generation or transcript metadata',async()=>{
 const f=fixture();try{
  f.setCli('omp');const boundary=event(2,'omp','omp-native');boundary.agent.transcriptPath='/synthetic/omp/current';
  const unknown=event(4,'omp','unknown-native');unknown.agent.event='future_status_ping';unknown.agent.transcriptPath='/synthetic/omp/wrong';
  f.setPage([boundary,event(3,'omp','omp-native','correct reply'),unknown]);await f.source.catchUp('web');
  assert.equal(f.bridge.get('web')?.cliId,'omp');assert.equal(f.bridge.get('web')?.nativeSessionId,'omp-native');assert.equal(f.bridge.get('web')?.transcriptPath,'/synthetic/omp/current');assert.equal(f.rebound(),1);assert.deepEqual(contents(f),['correct reply']);assert.equal(f.bridge.source('web').cursor,4);
 }finally{f.close();}
});


test('Claude exit then OMP in one shell preserves distinct histories and Claude bookmark across database reopen', async () => {
 const f=fixture('claude');let closed=false;try {
  const claude=f.store.conversations.findBySource('claude','native-shared')!;
  f.store.bookmarks.add({id:'saved-claude',groupId:null,cliId:'claude',nativeSessionId:'native-shared',cwd:f.dir,title:'Continue Claude later',note:'keep context'});
  f.setCli('');await f.source.catchUp('web');
  f.setCli('omp');f.setPage([event(2,'omp','native-shared'),event(3,'omp','native-shared','OMP distinct answer')]);await f.source.catchUp('web');
  const omp=f.store.conversations.findBySource('omp','native-shared')!;
  assert.notEqual(claude.id,omp.id);
  const generation=f.bridge.get('web')!.generation;
  f.source.dispose();f.store.close();closed=true;
  const reopened=createWorkspaceStore({dataDir:f.dir});try {
   assert.equal(reopened.conversations.findBySource('claude','native-shared')?.id,claude.id);
   assert.equal(reopened.conversations.findBySource('omp','native-shared')?.id,omp.id);
   assert.deepEqual(reopened.aiSessions.history!.pageMessages('web',f.first.generation).items.map(x=>x.event.content),['saved OpenCode answer']);
   assert.deepEqual(reopened.aiSessions.history!.pageMessages('web',generation).items.map(x=>x.event.content),['OMP distinct answer']);
   assert.equal(reopened.bookmarks.list().cards[0]?.note,'keep context');
  }finally{reopened.close();}
 }finally{if(closed) rmSync(f.dir,{recursive:true,force:true});else f.close();}
});
