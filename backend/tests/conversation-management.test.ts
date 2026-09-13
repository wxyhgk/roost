import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {spawned} from './helpers/fake-pty.ts';
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');

async function fixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'conversation-management-'));const store=createWorkspaceStore({dataDir:dir});const bridge=createAiSessionBridge({storage:store.aiSessions});
 const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
 const live=new Map<string,{id:string;cwd:string;pid:number|null;dead?:boolean;instanceId:string;cli:string}>();let connected=true,starts=0,writes=0;
 runtime.getSession=id=>live.get(id);runtime.isConnected=()=>connected;runtime.scanLiveSessions=async()=>{};
 runtime.resolveConversationRuntime=async conversationId=>{const run=store.conversationRuns.active(conversationId);if(!run)throw Object.assign(new Error('no fake owner candidate'),{code:'run_unavailable'});return{conversationId,runId:run.id,webSessionId:run.webSessionId,terminalInstanceId:run.terminalInstanceId,generation:run.generation,cliId:run.cliId,nativeSessionId:run.nativeSessionId,runtimeVerified:true as const};};
 runtime.ensureSession=async()=>{starts++;throw new Error('read-only management must not start a terminal');};runtime.writeSession=()=>{writes++;throw new Error('read-only management must not write input');};
 const server=createBackendServer({ auth: false,store,runtime,sessionBridge:bridge,workspaceRoot:dir});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.dispose();store.close();rmSync(dir,{recursive:true,force:true});});
 const request=(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const json=async(path:string,method='GET',body?:unknown)=>{const r=await request(path,method,body);const value=await r.json();assert.equal(r.status,200,path+' '+JSON.stringify(value));return value;};
 function bind(terminal:string,cli:string,native:string,content:string,withRun=true){
  store.upsertSession({id:terminal,cwd:dir});live.set(terminal,{id:terminal,cwd:dir,pid:41,instanceId:'instance-'+terminal,cli});
  const old=bridge.get(terminal),input={webSessionId:terminal,terminalInstanceId:'instance-'+terminal,cliId:cli,nativeSessionId:native};
  if(old)bridge.rebind(input,old.generation,old.revision);else bridge.bind(input);
  const binding=bridge.get(terminal)!;bridge.publish(terminal,{eventId:binding.generation+'/body',type:'message',role:'assistant',content});
  const current=bridge.get(terminal)!;const run=withRun?store.conversationRuns.observe(current,'test-owner'):undefined;
  const record=store.conversations.list({state:'all'}).items.find(x=>x.source.cliId===cli&&x.source.nativeSessionId===native)!;assert.ok(record);
  return{binding:current,run,record};
 }
 return{dir,store,bridge,runtime,live,request,json,bind,disconnect:()=>{connected=false;},reconnect:()=>{connected=true;},starts:()=>starts,writes:()=>writes};
}

test('conversation selection remains independent across terminal CLI switches and deletion while links are deduplicated',async t=>{
 const f=await fixture(t),spawnBefore=spawned.length;
 const a=f.bind('terminal','opencode','shared-native','OpenCode saved answer');
 const defaults=await f.json('/api/workspace');assert.equal(defaults.selectedConversationId,null);assert.equal(defaults.followTerminalConversation,false);
 await f.json('/api/workspace','PATCH',{selectedId:'terminal',selectedConversationId:a.record.id,followTerminalConversation:true});
 const b=f.bind('terminal','omp','shared-native','omp independent answer');
 let workspace=await f.json('/api/workspace');assert.equal(workspace.selectedConversationId,a.record.id,'follow is stored UI preference, not automatic backend selection');
 const oldRuntime=await f.request('/api/conversations/'+a.record.id+'/runtime');assert.equal(oldRuntime.status,409);assert.equal((await oldRuntime.json()).error.code,'run_unavailable');
 const aAgain=f.bind('terminal','opencode','shared-native','OpenCode resumed answer');assert.equal(aAgain.record.id,a.record.id);
 const links=await f.json('/api/conversations?terminalId=terminal&state=all');assert.deepEqual(links.items.map((x:any)=>x.id).sort(),[a.record.id,b.record.id].sort());
 const deletion=await f.request('/api/sessions/terminal/kill','POST');assert.equal(deletion.status,200);
 workspace=await f.json('/api/workspace');assert.equal(workspace.selectedConversationId,a.record.id);assert.equal(workspace.followTerminalConversation,true);
 const saved=await f.json('/api/conversations/'+a.record.id+'/messages');assert.ok(saved.items.some((x:any)=>x.event.content==='OpenCode saved answer'));assert.ok(saved.items.every((x:any)=>x.event.content!=='omp independent answer'));
 const after=await f.json('/api/conversations?terminalId=terminal&state=all');assert.equal(after.items.length,2,'removed terminal associations remain historical');
 const second=createWorkspaceStore({dataDir:f.dir});try{assert.equal(second.loadWorkspace().selectedConversationId,a.record.id);assert.equal(second.loadWorkspace().followTerminalConversation,true);}finally{second.close();}
 assert.equal(f.starts(),0);assert.equal(f.writes(),0);assert.equal(spawned.length,spawnBefore);
});

test('history remains unverified while explicit runtime resolution rejects disconnected, replaced and stale bindings',async t=>{
 const f=await fixture(t),item=f.bind('terminal','omp','native','saved');const path='/api/conversations/'+item.record.id;
 const history=await f.json(path+'/runs');assert.ok(history.items.every((x:any)=>x.runtimeVerified===false));
 const verified=await f.json(path+'/runtime');assert.equal(verified.runtimeVerified,true);assert.equal(verified.runId,item.run!.id);
 const failure=async(status:number,code:string)=>{const r=await f.request(path+'/runtime');assert.equal(r.status,status);assert.equal((await r.json()).error.code,code);};
 f.disconnect();await failure(503,'runtime_unavailable');f.reconnect();
 const live=f.live.get('terminal')!;f.live.delete('terminal');await failure(409,'run_unavailable');f.live.set('terminal',live);
 // Defensive malformed-runtime probe: actual TerminalSession contract requires a positive PID and omits dead.
 f.live.set('terminal',{...live,pid:null,dead:true});await failure(409,'run_unavailable');f.live.set('terminal',live);
 f.store.setSessionClosed('terminal',true);await failure(409,'run_unavailable');f.store.setSessionClosed('terminal',false);
 f.live.set('terminal',{...live,instanceId:'replacement'});await failure(409,'run_unavailable');
 f.live.set('terminal',{...live,cli:'opencode'});await failure(409,'run_unavailable');f.live.set('terminal',live);
 const resolve=f.runtime.resolveConversationRuntime;delete f.runtime.resolveConversationRuntime;await failure(503,'runtime_unavailable');f.runtime.resolveConversationRuntime=resolve;
 const originalResolve=f.runtime.resolveConversationRuntime!;f.runtime.resolveConversationRuntime=async id=>{const candidate=await originalResolve(id);f.live.set('terminal',{...live,instanceId:'changed-during-RPC'});return candidate;};await failure(409,'run_unavailable');f.runtime.resolveConversationRuntime=originalResolve;f.live.set('terminal',live);
 const binding=f.bridge.get('terminal')!;f.bridge.rebind({...binding,nativeSessionId:'another-native'},binding.generation,binding.revision);
 assert.equal(f.store.conversationRuns.get(item.run!.id)!.state,'active','fixture deliberately retains stale recorded-active evidence');await failure(409,'run_unavailable');
 assert.ok((await f.json(path+'/runs')).items.every((x:any)=>x.runtimeVerified===false));
 assert.equal(f.starts(),0);assert.equal(f.writes(),0);
});

test('run history paginates independently of legacy generations without duplicate run and generation rows',async t=>{
 const f=await fixture(t);const first=f.bind('terminal','omp','target','legacy generation',false);
 f.bind('terminal','omp','elsewhere','other conversation');f.bind('terminal','omp','target','first run');f.bind('terminal','omp','elsewhere','other again');f.bind('terminal','omp','target','second run');
 const path='/api/conversations/'+first.record.id+'/runs';const collected:any[]=[];let cursor:string|undefined,firstCursor:string|undefined;
 do{const page=await f.json(path+'?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(page.items.length,1);collected.push(...page.items);cursor=page.nextCursor??undefined;if(collected.length===1)firstCursor=cursor;assert.ok(collected.length<=3);}while(cursor);
 assert.equal(collected.length,3);assert.equal(collected.filter(x=>x.runId!==null).length,2);assert.equal(collected.filter(x=>x.runId===null).length,1);assert.equal(new Set(collected.map(x=>x.generation)).size,3);
 const absent=await f.json(path+'?terminalId=missing');assert.deepEqual(absent.items,[]);
 const other=f.store.conversations.list({state:'all'}).items.find(x=>x.id!==first.record.id)!;assert.ok(firstCursor);
 for(const target of ['/api/conversations/'+other.id+'/runs?cursor='+encodeURIComponent(firstCursor!),path+'?terminalId=terminal&cursor='+encodeURIComponent(firstCursor!)]){const response=await f.request(target);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'invalid_request');}
});

test('management query and selection failures retain stable errors and do not partially change selection',async t=>{
 const f=await fixture(t),a=f.bind('terminal','omp','a','body');await f.json('/api/workspace','PATCH',{selectedConversationId:a.record.id,followTerminalConversation:true});
 for(const suffix of ['?limit=0','?limit=201','?limit=1&limit=2','?cursor=','?unknown=x','?terminalId=']){
  const r=await f.request('/api/conversations/'+a.record.id+'/runs'+suffix);assert.equal(r.status,400,suffix);assert.equal((await r.json()).error.code,'invalid_request');
 }
 assert.equal((await f.request('/api/conversations/missing/runs')).status,404);assert.equal((await f.request('/api/conversations/missing/runtime')).status,404);
 for(const [body,status] of [[{selectedConversationId:123},400],[{followTerminalConversation:'yes'},400],[{selectedConversationId:'missing',followTerminalConversation:false},404]] as const){const r=await f.request('/api/workspace','PATCH',body);assert.equal(r.status,status);assert.ok((await r.json()).error.code);const unchanged=await f.json('/api/workspace');assert.equal(unchanged.selectedConversationId,a.record.id);assert.equal(unchanged.followTerminalConversation,true);}
 await f.json('/api/workspace','PATCH',{selectedConversationId:null});assert.equal((await f.json('/api/workspace')).selectedConversationId,null);
});
