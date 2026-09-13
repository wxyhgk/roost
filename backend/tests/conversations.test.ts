import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createWorkspaceStore} from '@roost/workspace-store';
import {handleConversations} from '../src/conversations.ts';
import {spawned} from './helpers/fake-pty.ts';
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');

async function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'conversations-http-g1-'));
  const store=createWorkspaceStore({dataDir:dir});
  const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  const server=createBackendServer({ auth: false,store,runtime,sessionBridge:bridge,workspaceRoot:dir});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));runtime.dispose();store.close();rmSync(dir,{recursive:true,force:true});});
  const request=(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  function bind(native='native') {
    store.upsertSession({id:native,cwd:dir});
    return bridge.bind({webSessionId:native,terminalInstanceId:'instance-'+native,cliId:'omp',nativeSessionId:native});
  }
  return {dir,store,runtime,bridge,request,bind};
}

test('conversation list exposes nullable first user previews in both sort modes without replacing titles or starting PTYs',async t=>{
  const f=await fixture(t),beforeSpawn=spawned.length;
  f.bind('empty'); f.bind('question');
  f.bridge.publish('question',{type:'message',role:'assistant',eventId:'assistant',content:'Ignore assistant text'});
  f.bridge.publish('question',{type:'message',role:'user',eventId:'user',content:'  修复\n 前端布局 😀  '});
  const title=f.store.conversations.list().items.find(row=>row.source.nativeSessionId==='question')!.title;
  for(const sort of ['created','activity']) {
    const response=await f.request('/api/conversations?sort='+sort);assert.equal(response.status,200);
    const {items}=await response.json();
    assert.equal(items.find((row:any)=>row.source.nativeSessionId==='empty').firstUserMessagePreview,null);
    const question=items.find((row:any)=>row.source.nativeSessionId==='question');
    assert.equal(question.firstUserMessagePreview,'修复 前端布局 😀');assert.equal(question.title,title);
  }
  assert.equal(spawned.length,beforeSpawn);
});

test('conversation routes list and read archived messages after final terminal deletion without spawning PTY',async t=>{
  const f=await fixture(t),beforeSpawn=spawned.length;f.bind();
  for(let i=0;i<3;i++)f.bridge.publish('native',{type:'message',eventId:'message/'+i,content:'stored body '+i});
  const record=f.store.conversations.list().items[0]!;
  f.store.deleteSessionRecord('native');
  const list=await f.request('/api/conversations');assert.equal(list.status,200);
  assert.equal((await list.json()).items[0].id,record.id);
  const prefix='/api/conversations/'+record.id;
  const detail=await f.request(prefix);assert.equal(detail.status,200);
  assert.equal((await detail.json()).source.nativeSessionId,'native');
  const page=await(await f.request(prefix+'/messages?limit=2')).json();
  assert.equal(page.items.length,2);assert.equal(page.conversationId,record.id);
  const second=await(await f.request(prefix+'/messages?limit=2&cursor='+encodeURIComponent(page.nextCursor))).json();
  assert.equal(second.items.length,1);
  assert.equal(new Set([...page.items,...second.items].map(x=>x.messageId)).size,3);
  const body=await f.request(prefix+'/messages/'+encodeURIComponent('message/0'));
  assert.equal(body.status,200);assert.equal((await body.json()).event.content,'stored body 0');
  assert.equal(spawned.length,beforeSpawn,'read-only conversation HTTP must not spawn CLI');
  assert.equal(f.runtime.getSession('native'),undefined);
});

test('PATCH returns revision conflict with current record and archive/project filters preserve content',async t=>{
  const f=await fixture(t);f.bind();
  const record=f.store.conversations.list().items[0]!,url='/api/conversations/'+record.id;
  let response=await f.request(url,'PATCH',{revision:record.revision,title:'  User title  '});
  assert.equal(response.status,200);const updated=await response.json();assert.equal(updated.title,'User title');
  response=await f.request(url,'PATCH',{revision:record.revision,title:'Stale title'});
  assert.equal(response.status,409);const conflict=await response.json();
  assert.equal(conflict.error.code,'conflict');assert.equal(conflict.current.title,'User title');
  response=await f.request(url,'PATCH',{revision:updated.revision,archived:true});assert.equal(response.status,200);
  assert.equal((await(await f.request('/api/conversations')).json()).items.length,0);
  assert.equal((await(await f.request('/api/conversations?state=archived&projectId=null')).json()).items[0].id,record.id);
  assert.equal((await f.request('/api/conversations/missing')).status,404);
  assert.equal((await f.request(url+'/messages/missing')).status,404);
});

test('HTTP list search is literal and page previews are bounded while detail preserves full content',async t=>{
  const f=await fixture(t);f.bind('literal');f.bind('other');
  for(const r of f.store.conversations.list().items)f.store.conversations.patch(r.id,{revision:r.revision,title:r.source.nativeSessionId==='literal'?'100%_ target':'100ZZ other'});
  const matching=await(await f.request('/api/conversations?q='+encodeURIComponent('%_'))).json();assert.equal(matching.items.length,1);
  const content='wide '.repeat(100000)+'HTTP_TAIL_NEEDLE';
  f.bridge.publish('literal',{type:'message',eventId:'large',content});
  const url='/api/conversations/'+matching.items[0].id+'/messages';
  const response=await f.request(url+'?limit=1');assert.equal(response.status,200);
  const preview=await response.text();assert.ok(Buffer.byteLength(preview)<160*1024);
  assert.equal((await(await f.request(url+'/large')).json()).event.content,content);
  const tailSearch=await(await f.request('/api/conversations?q=HTTP_TAIL_NEEDLE')).json();
  assert.deepEqual(tailSearch.items.map(x=>x.id),[matching.items[0].id]);
});

test('conversation HTTP rejects invalid queries, bodies and unsupported methods with stable JSON errors',async t=>{
  const f=await fixture(t);f.bind();const record=f.store.conversations.list().items[0]!;
  for(const suffix of ['?limit=0','?limit=201','?limit=1.5','?limit=1&limit=2','?q=x&q=y','?state=running','?other=1','?projectId=','?cursor=']) {
    const r=await f.request('/api/conversations'+suffix);assert.equal(r.status,400,suffix);assert.equal((await r.json()).error.code,'invalid_request');
  }
  const url='/api/conversations/'+record.id;
  for(const body of [{title:'missing revision'},{revision:1},{revision:1,title:''},{revision:1,title:'\u001bhidden'},{revision:1,archived:'yes'},{revision:1,unknown:1},{revision:1,projectId:2}]) {
    const r=await f.request(url,'PATCH',body);assert.equal(r.status,400,JSON.stringify(body));assert.equal((await r.json()).error.code,'invalid_request');
  }
  const tooLarge=await f.request(url,'PATCH',{revision:1,title:'x'.repeat(20000)});assert.equal(tooLarge.status,413);assert.equal((await tooLarge.json()).error.code,'too_large');
  assert.equal((await f.request('/api/conversations/%E0%A4%A')).status,400);
  assert.equal((await f.request(url+'/messages?state=all')).status,400);
  const method=await f.request(url,'DELETE');assert.equal(method.status,405);assert.equal(method.headers.get('allow'),'GET, PATCH');
  assert.equal((await method.json()).error.code,'method_not_allowed');
});

test('conversation handler masks storage failures without leaking SQLite paths',async t=>{
  const store={list(){throw new Error('SQLITE_BUSY /private/sensitive.sqlite');}} as any;
  const server=createServer((req,res)=>void handleConversations(req,res,new URL(req.url!,'http://localhost'),store));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/conversations`);
  assert.equal(response.status,503);const body=await response.json();assert.equal(body.error.code,'storage_unavailable');assert.ok(!JSON.stringify(body).includes('/private/'));
});
