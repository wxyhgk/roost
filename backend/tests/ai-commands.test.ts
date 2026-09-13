import './helpers/fake-pty.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {WebSocket} from 'ws';import type {TerminalEvent} from '@roost/terminal-runtime';
const {createWorkspaceStore}=await import('@roost/workspace-store');
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createAiSessionBridge}=await import('@roost/ai-session-bridge');
const {createBackendServer}=await import('../src/server.ts');

test('command HTTP returns accepted-for-processing, durable queries/cancel and independent WS status', {timeout:10000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'command-route-')),store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd:dir});
 const baseRuntime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store}),live=baseRuntime.ensureSession('s',dir);
 const listeners=new Set<(e:TerminalEvent)=>void>();
 const runtime={...baseRuntime,subscribe:(id:string,fn:(e:TerminalEvent)=>void)=>{listeners.add(fn);const stop=baseRuntime.subscribe(id,fn);return()=>{listeners.delete(fn);stop();};},
 commandControl:async()=>({supported:true,reason:null,inputEpoch:0,queue:store.aiCommands.active('s')}),
 enqueueCommand:async(id:string,input:any)=>{const c=store.aiCommands.enqueue(id,input);for(const fn of listeners)fn({type:'command-status',command:c});return c;},
 cancelCommand:async(id:string,r:string)=>store.aiCommands.cancel(id,r)};
 const bridge=createAiSessionBridge({storage:store.aiSessions});const binding=bridge.bind({webSessionId:'s',terminalInstanceId:live.instanceId,cliId:'claude',nativeSessionId:'native'});
 const server=createBackendServer({ auth: false,store,runtime,workspaceRoot:dir,sessionBridge:bridge});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address()as any).port}`;const sockets:WebSocket[]=[];
 t.after(async()=>{sockets.forEach(s=>s.terminate());server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));runtime.dispose();store.close();await rm(dir,{recursive:true,force:true});});
 const ws=new WebSocket(base.replace('http','ws')+'/api/ai-sessions/s/events');sockets.push(ws);const messages:any[]=[];ws.on('message',s=>messages.push(JSON.parse(String(s))));await once(ws,'open');
 const input={requestId:'r',type:'submit',terminalInstanceId:live.instanceId,generation:binding.generation,nativeSessionId:'native',text:'hello'};
 const post=(body:any)=>fetch(base+'/api/ai-sessions/s/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const response=await post(input);assert.equal(response.status,202);assert.equal((await response.json()as any).status,'queued');
 assert.equal((await post(input)).status,202);assert.equal((await post({...input,text:'different'})).status,409);
 assert.equal((await post({})).status,400);assert.equal((await post({...input,extra:true})).status,400);
 assert.equal((await(await fetch(base+'/api/ai-sessions/s')).json()as any).control.supported,true);
 const page:any=await(await fetch(base+'/api/ai-sessions/s/commands')).json();assert.equal(page.items.length,1);
 assert.equal((await fetch(base+'/api/ai-sessions/s/commands?limit=0')).status,400);
 assert.equal((await fetch(base+'/api/ai-sessions/missing/commands')).status,404);
 const cancelled:any=await(await fetch(base+'/api/ai-sessions/s/commands/r/cancel',{method:'POST'})).json();assert.equal(cancelled.status,'cancelled');
 await new Promise(r=>setTimeout(r,30));assert.ok(messages.some(m=>m.type==='command-status'&&m.command.requestId==='r'));
 assert.equal(bridge.read('s',0).events.filter(e=>e.event.type==='message').length,0,'command records do not become native messages');
});
