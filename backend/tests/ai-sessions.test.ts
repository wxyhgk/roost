import { WebSocket } from "ws";
import { createAiSessionBridge } from "@roost/ai-session-bridge";
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readOmpTranscript } from '@roost/ai-transcript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import './helpers/fake-pty.ts';

const {createWorkspaceStore}=await import('@roost/workspace-store');
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');
const {createCliIconStore}=await import('../src/cli-configs.ts');
async function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'roost-cli-http-')),store=createWorkspaceStore({dataDir:dir});
  const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  const server=createBackendServer({ auth: false,store,runtime,sessionBridge:bridge,workspaceRoot:dir,cliIcons:createCliIconStore(join(dir,'icons'))});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));runtime.dispose();store.close();rmSync(dir,{recursive:true,force:true})});
  const request=(method:string,path:string,body?:unknown)=>fetch(base+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {dir,store,runtime,request,base,bridge};
}

test('AI binding HTTP rejects unknown sessions, wrong identity and unavailable PTYs with stable errors', async t => {
  const f = await fixture(t);
  const payload = { terminalInstanceId: 'instance', cliId: 'claude', nativeSessionId: 'native' };
  let res = await f.request('POST', '/api/ai-sessions/missing', payload);
  assert.equal(res.status, 404); assert.equal((await res.json()).error.code, 'not_found');
  f.store.upsertSession({ id: 'web', cwd: f.dir });
  res = await f.request('POST', '/api/ai-sessions/web', { ...payload, webSessionId: 'other' });
  assert.equal(res.status, 400);
  res = await f.request('POST', '/api/ai-sessions/web', payload);
  assert.equal(res.status, 409); assert.equal((await res.json()).error.code, 'conflict');
  res = await f.request('GET', '/api/ai-sessions/%E0%A4%A');
  assert.equal(res.status, 400);
});
test('persisted bindings expose offline snapshot and per-session cursor through HTTP after server recreation', async t => {
  const f = await fixture(t);
  const { createAiSessionBridge } = await import('@roost/ai-session-bridge');
  const bridge = createAiSessionBridge({ storage: f.store.aiSessions });
  bridge.bind({ webSessionId: 'web', terminalInstanceId: 'instance', cliId: 'claude', nativeSessionId: 'native' });
  bridge.publish('web', { eventId: '1', type: 'message', content: 'retained' });
  const server = createBackendServer({ auth: false, store: f.store, runtime: f.runtime, workspaceRoot: f.dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const res = await fetch(base + '/api/ai-sessions/web?afterSeq=0');
  const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.binding.state, 'offline');
  assert.equal(body.cursor, 1); assert.equal(body.events[0].event.content, 'retained');
  assert.equal((await fetch(base + '/api/ai-sessions/web?afterSeq=-1')).status, 400);
  assert.equal((await fetch(base + '/api/ai-sessions/web?afterSeq=2')).status, 400);
});

test('business server upgrades AI event route and closes stream on session deletion', async t => {
  const f = await fixture(t);
  f.store.upsertSession({ id: 'web', cwd: f.dir });
  // Keep the binding live across the background observer's refresh interval;
  // otherwise slower hosts legitimately append an offline event before the WS.
  f.runtime.getSession = id => id === 'web' ? { id, cwd: f.dir, pid: 1, instanceId: 'i', cli: 'claude' } : undefined;
  f.bridge.bind({ webSessionId: 'web', terminalInstanceId: 'i', cliId: 'claude', nativeSessionId: 'n' });
  f.bridge.publish('web', { eventId: '1', type: 'message' });
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/api/ai-sessions/web/events?afterSeq=0');
  t.after(() => ws.terminate());
  const [data] = await once(ws, 'message');
  const snapshot = JSON.parse(data.toString());
  assert.equal(snapshot.type, 'ai-session-snapshot'); assert.equal(snapshot.cursor, 1);
  const next = once(ws, 'message');
  f.bridge.publish('web', { eventId: '2', type: 'message' });
  assert.equal(JSON.parse((await next)[0].toString()).type, 'ai-session-event');
  const closed = once(ws, 'close');
  assert.equal((await f.request('POST', '/api/sessions/web/kill')).status, 200);
  assert.equal((await closed)[0], 1008);
});

test('explicit rebind requires observed native identity and expected version, invalidates previous generation', async t => {
  const f=await fixture(t);
  f.store.upsertSession({id:'web',cwd:f.dir});
  f.bridge.bind({webSessionId:'web',terminalInstanceId:'instance',cliId:'omp',nativeSessionId:'old'});
  f.runtime.getSession=id=>id==='web'?{id,cwd:f.dir,pid:1,instanceId:'instance',cli:'omp'}:undefined;
  Object.assign(f.runtime,{
    supportsAgentReplay:()=>true,
    readAgentEvents:async(_id:string,_instance:string,after:number)=>({events:after<1?[{terminalInstanceId:'instance',sourceSeq:1,agent:{event:'session_start',sessionId:'new'}}]:[],cursor:1,highWater:1,more:false,hasGap:false}),
  });
  const payload=()=>{const binding=f.bridge.get('web')!;return {terminalInstanceId:'instance',cliId:'omp',nativeSessionId:'new',expectedGeneration:binding.generation,expectedRevision:binding.revision};};
  assert.equal((await f.request('POST','/api/ai-sessions/web/rebind',{...payload(),nativeSessionId:'unseen'})).status,409);
  assert.equal((await f.request('POST','/api/ai-sessions/web/rebind',{...payload(),expectedRevision:-1})).status,409);
  const before=payload();
  const ws=new WebSocket(f.base.replace('http:','ws:')+'/api/ai-sessions/web/events');
  t.after(()=>ws.terminate());await once(ws,'message');
  const closed=once(ws,'close');
  const res=await f.request('POST','/api/ai-sessions/web/rebind',payload());
  assert.equal(res.status,200);
  const body=await res.json();assert.notEqual(body.binding.generation,before.expectedGeneration);
  assert.equal((await closed)[0],1008);
  const retry=await f.request('POST','/api/ai-sessions/web/rebind',before);
  assert.equal(retry.status,200);
  assert.equal((await retry.json()).binding.generation,body.binding.generation);
  const stale=await f.request('GET','/api/ai-sessions/web?generation='+before.expectedGeneration);
  assert.equal(stale.status,409);
});

test('diagnostics HTTP reports backend and capability without modifying workspace',async t=>{
  const f=await fixture(t),before=f.store.loadWorkspace();
  const response=await f.request('GET','/api/diagnostics');
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.schemaVersion,1);
  assert.equal(body.daemon.agentReplaySupported,false);
  assert.equal(body.ai.bindings,0);
  assert.deepEqual(f.store.loadWorkspace(),before);
});

test('transcript replaces OSC over WebSocket and detail HTTP rejects changed content and stale generations', async t => {
  const f = await fixture(t), path = join(f.dir, 'native.jsonl');
  const header = {type:'session',version:3,id:'native'};
  const row = {type:'message',id:'tool-row',message:{role:'toolResult',toolCallId:'call',toolName:'bash',content:[{type:'text',text:'x'.repeat(6000)}]}};
  writeFileSync(path, [header,row].map(value=>JSON.stringify(value)).join('\n')+'\n');
  const binding = f.bridge.bind({webSessionId:'web',terminalInstanceId:'i',cliId:'omp',nativeSessionId:'native',transcriptPath:path});
  f.bridge.publish('web',{eventId:'osc',type:'message',content:'OSC fallback'});
  const ws = new WebSocket(f.base.replace('http:', 'ws:')+'/api/ai-sessions/web/events');
  t.after(()=>ws.terminate());
  await once(ws,'message');
  const replacement = once(ws,'message');
  f.bridge.ingestTranscript('web',binding.generation,await readOmpTranscript(path,'native'));
  const snapshot = JSON.parse((await replacement)[0].toString());
  const closed = once(ws,'close'); ws.close(); await closed;
  assert.equal(snapshot.type,'ai-session-snapshot');
  const messages = snapshot.events.filter((entry:any)=>entry.event.type==='message');
  assert.equal(messages.length,1);
  assert.equal(messages[0].event.data.source,'transcript');
  assert.equal(messages[0].event.data.truncated,true);
  const route = '/api/ai-sessions/web/transcript/'+encodeURIComponent(messages[0].event.eventId);
  const detail = await f.request('GET',route+'?generation='+binding.generation);
  assert.equal(detail.status,200);
  assert.equal((await detail.json()).event.data.parts.find((part:any)=>part.type==='text').text,'x'.repeat(6000));
  assert.equal((await f.request('GET',route+'?generation=stale')).status,409);
  row.message.content[0].text='y'.repeat(6000);
  writeFileSync(path,[header,row].map(value=>JSON.stringify(value)).join('\n')+'\n');
  assert.equal((await f.request('GET',route)).status,409);
});
