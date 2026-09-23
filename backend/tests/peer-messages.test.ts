import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createConversationMessagingHandler} from '../src/peer-messages.ts';
import {createConversationStream,MAX_CONVERSATION_STREAM_PENDING_BYTES} from '../src/conversation-stream.ts';
import './helpers/fake-pty.ts';
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');

async function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'g2-peer-http-')),store=createWorkspaceStore({dataDir:dir});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  store.upsertSession({id:'terminal',cwd:dir});
  bridge.bind({webSessionId:'terminal',terminalInstanceId:'instance',cliId:'omp',nativeSessionId:'native'});
  const id=store.conversations.list().items[0]!.id;
  const server=createBackendServer({ auth: false,store,runtime,sessionBridge:bridge,workspaceRoot:dir});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));runtime.dispose();store.close();rmSync(dir,{recursive:true,force:true});});
  const request=(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {dir,store,bridge,runtime,id,base,request};
}

function connect(url:string) {
  const ws=new WebSocket(url),frames:any[]=[];
  ws.on('message',raw=>frames.push(JSON.parse(raw.toString())));
  return {ws,frames,async wait(predicate:(frame:any)=>boolean){
    for(let i=0;i<100;i++){const found=frames.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,20));}
    assert.fail('expected WebSocket frame not received');
  }};
}

test('HTTP queues durable user mail, rejects sender impersonation, preserves idempotency and cancel state',async t=>{
  const f=await fixture(t),url='/api/conversations/'+f.id+'/inbox',input={requestId:'one',text:'HTTP queued'};
  let response=await f.request(url,'POST',input);assert.equal(response.status,202);const saved=await response.json();
  assert.equal(saved.message.senderKind,'user');assert.equal(saved.message.senderConversationId,null);assert.equal(saved.delivery.state,'queued');
  response=await f.request(url,'POST',input);assert.equal((await response.json()).message.id,saved.message.id);
  response=await f.request(url,'POST',{...input,text:'changed'});assert.equal(response.status,409);assert.equal((await response.json()).error.code,'request_conflict');
  response=await f.request(url,'POST',{requestId:'spoof',text:'spoof',senderConversationId:f.id});assert.equal(response.status,400);
  // dismiss 只给状态不明的：排队中的走它必须 409，而同一条走 cancel 是 200——这一对能分辨路由接到了哪里。
  response=await f.request('/api/peer-deliveries/'+saved.delivery.id+'/dismiss','POST',{});assert.equal(response.status,409);assert.equal((await response.json()).error.code,'not_uncertain');
  assert.equal((await f.request('/api/peer-deliveries/'+saved.delivery.id+'/dismiss')).status,405);
  const cancelled=await(await f.request('/api/peer-deliveries/'+saved.delivery.id+'/cancel','POST',{})).json();
  /*
    **返回的是整条（消息 + 投递）**，不是光一个投递。调用方按 `{message, delivery}` 用——
    前端 merge 拿 `detail.message.id` 去替换列表里那一条；少了 message 就读 undefined.id，
    异常抛在 render 里被 ErrorBoundary 接住，**整个右侧面板**一起降级。
    2026-09-23 点「移除」当场白屏，而这条用例当时正把错的形状当成契约钉着。
  */
  assert.equal(cancelled.delivery.state,'cancelled');
  assert.equal(cancelled.message.id,saved.message.id,'必须带上消息本身');
  assert.equal((await(await f.request('/api/peer-messages/'+saved.message.id)).json()).delivery.state,'cancelled');
  // 终态的出口：移除。三个出口（cancel / dismiss / remove）返回同一个形状。
  const removed=await(await f.request('/api/peer-deliveries/'+saved.delivery.id+'/remove','POST',{})).json();
  assert.equal(removed.delivery.reason,'user_removed');
  assert.equal(removed.delivery.state,'cancelled','移除不改状态');
  assert.equal(removed.message.id,saved.message.id);
  f.store.deleteSessionRecord('terminal');
  assert.equal((await(await f.request(url)).json()).items.length,1);
  assert.equal((await f.request(url,'POST',{requestId:'offline',text:'read later'})).status,202);
  assert.equal(f.runtime.getSession('terminal'),undefined);
});

test('HTTP mailbox validation and byte limits return stable errors without creating extra mail',async t=>{
  const f=await fixture(t),url='/api/conversations/'+f.id+'/inbox';
  for(const suffix of ['?limit=0','?limit=101','?cursor=','?limit=1&limit=2','?sender=x'])assert.equal((await f.request(url+suffix)).status,400,suffix);
  for(const body of [{requestId:'x',text:1},{requestId:'x',text:'\u001b'},{requestId:'x',text:'ok',inReplyTo:2},{text:'no request'}])assert.equal((await f.request(url,'POST',body)).status,400);
  const large=await f.request(url,'POST',{requestId:'large',text:'x'.repeat(15361)});assert.equal(large.status,413);assert.equal((await large.json()).error.code,'too_large');
  assert.equal((await(await f.request(url)).json()).items.length,0);
  assert.equal((await f.request('/api/peer-messages/unknown')).status,404);
  const method=await f.request(url,'DELETE');assert.equal(method.status,405);assert.equal((await method.json()).error.code,'method_not_allowed');
});

test('WebSocket resumes committed changes between snapshot and subscribe and continues live updates',async t=>{
  const f=await fixture(t),prefix='/api/conversations/'+f.id,snapshot=await(await f.request(prefix+'/snapshot')).json();
  const first=await(await f.request(prefix+'/inbox','POST',{requestId:'before-connect',text:'saved before WS'})).json();
  const live=connect(f.base.replace('http:','ws:')+prefix+'/stream?cursor='+encodeURIComponent(snapshot.cursor));
  t.after(()=>live.ws.terminate());
  const catchup=await live.wait(frame=>frame.type==='changes'&&frame.items.some((x:any)=>x.entityId===first.message.id));
  const second=await(await f.request(prefix+'/inbox','POST',{requestId:'while-connected',text:'live'})).json();
  await live.wait(frame=>frame.type==='changes'&&frame.items.some((x:any)=>x.entityId===second.message.id));
  const seen=live.frames.filter(x=>x.type==='changes').flatMap(x=>x.items.map((i:any)=>i.seq));
  assert.equal(new Set(seen).size,seen.length,'catchup and poll do not repeat seq');
  const polled=await(await f.request(prefix+'/changes?cursor='+encodeURIComponent(catchup.cursor))).json();
  assert.ok(polled.items.some((x:any)=>x.entityId===second.message.id));
  const closed=once(live.ws,'close');live.ws.close();await closed;
});

test('HTTP snapshot cursor is rejected by a replacement gateway and pruned history requires resync',async t=>{
  const f=await fixture(t),prefix='/api/conversations/'+f.id;
  const snapshot=await(await f.request(prefix+'/snapshot')).json();
  const handler=createConversationMessagingHandler(f.store);
  const other=createServer((req,res)=>void handler.handle(req,res,new URL(req.url!,'http://localhost')));
  other.listen(0,'127.0.0.1');await once(other,'listening');
  try {
    const url=`http://127.0.0.1:${(other.address() as {port:number}).port}${prefix}/changes?cursor=${encodeURIComponent(snapshot.cursor)}`;
    const response=await fetch(url);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'resync_required');
  }finally{handler.dispose();other.closeAllConnections();await new Promise<void>(r=>other.close(()=>r()));}
  await f.request(prefix+'/inbox','POST',{requestId:'prune',text:'event'});f.store.conversationChanges.prune(0);
  const expired=await f.request(prefix+'/changes?cursor='+encodeURIComponent(snapshot.cursor));assert.equal(expired.status,409);assert.equal((await expired.json()).error.code,'resync_required');
});

class FakeSocket extends EventEmitter {
  OPEN=1;readyState=1;bufferedAmount=0;frames:any[]=[];terminated=false;closeCode:number|undefined;
  send(text:string,callback?:(error?:Error)=>void){this.frames.push(JSON.parse(text));callback?.();}
  terminate(){this.terminated=true;this.readyState=3;this.emit('close');}
  close(code?:number){this.closeCode=code;this.readyState=3;this.emit('close');}
}

test('slow WebSocket clients are isolated and stream disposal closes only owned subscriptions',async t=>{
  const f=await fixture(t),stream=createConversationStream(f.store),slow=new FakeSocket(),healthy=new FakeSocket();
  t.after(()=>stream.dispose());slow.bufferedAmount=MAX_CONVERSATION_STREAM_PENDING_BYTES;
  stream.attach(slow as unknown as WebSocket,f.id);assert.equal(slow.terminated,true);
  stream.attach(healthy as unknown as WebSocket,f.id);assert.equal(healthy.frames[0].type,'snapshot');assert.equal(healthy.terminated,false);
  f.store.peerMessages.send({kind:'user'},{recipientId:f.id,requestId:'healthy',text:'still works'});
  for(let i=0;i<30&&!healthy.frames.some(x=>x.type==='changes');i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(healthy.frames.some(x=>x.type==='changes'));
  assert.equal(slow.listenerCount('message'),0);assert.equal(slow.listenerCount('close'),0);
  stream.dispose();assert.equal(healthy.closeCode,1012);assert.equal(healthy.listenerCount('message'),0);
});

test('read-only stream rejects incoming payloads and invalid cursor sends explicit resync error',async t=>{
  const f=await fixture(t),stream=createConversationStream(f.store),input=new FakeSocket(),bad=new FakeSocket();t.after(()=>stream.dispose());
  stream.attach(input as unknown as WebSocket,f.id);input.emit('message',Buffer.from('submit'));
  assert.equal(input.closeCode,1008);assert.equal(f.store.peerMessages.inbox(f.id).items.length,0);
  stream.attach(bad as unknown as WebSocket,f.id,{cursor:'invalid'});
  assert.equal(bad.frames[0].type,'error');assert.equal(bad.frames[0].error.code,'resync_required');assert.equal(bad.closeCode,1008);
});
