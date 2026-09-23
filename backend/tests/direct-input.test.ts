import './helpers/fake-pty.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const {createWorkspaceStore}=await import('@roost/workspace-store');
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');

async function fixture(t:any,typeText?:(id:string,text:string)=>Promise<unknown>) {
  const dir=await mkdtemp(join(tmpdir(),'direct-input-')),store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd:dir});
  const base=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  const runtime={...base,...(typeText?{typeText}:{})};
  const server=createBackendServer({auth:false,store,runtime,workspaceRoot:dir});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));base.dispose();store.close();await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${(server.address()as any).port}`;
  const post=(id:string,body:unknown)=>fetch(`${url}/api/ai-sessions/${id}/type`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return {url,post};
}

test('打字请求原样交给 daemon，结果原样带回来', async t=>{
  const calls:unknown[][]=[];
  const f=await fixture(t,async(id,text)=>{calls.push([id,text]);return {status:'submitted',cli:'claude'};});
  const response=await f.post('s',{text:'后续可以做什么'});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:'submitted',cli:'claude'});
  assert.deepEqual(calls,[['s','后续可以做什么']]);
  assert.equal((await f.post('missing',{text:'hi'})).status,404,'没有这个终端');
  assert.equal((await f.post('s',{text:'hi',requestId:'x'})).status,400,'不认识的字段一律拒绝');
  assert.equal((await fetch(`${f.url}/api/ai-sessions/s/type`)).status,405);
  assert.equal(calls.length,1,'被拒的请求一个都没到 daemon');
});

test('daemon 的拒绝按原码转出去，别的故障一律 503', async t=>{
  const f=await fixture(t,async(_id,text)=>{
    if(text==='bad')throw Object.assign(new Error('text required'),{status:400,code:'invalid_request'});
    if(text==='old')throw new Error('unknown terminal operation');
    throw new Error('socket closed');
  });
  const bad=await f.post('s',{text:'bad'});
  assert.equal(bad.status,400);assert.equal(((await bad.json())as any).error.code,'invalid_request');
  assert.equal((await f.post('s',{text:'boom'})).status,503);
  const old=await f.post('s',{text:'old'});
  assert.equal(old.status,409,'旧 daemon 不是坏了，是还没重启');assert.equal(((await old.json())as any).error.code,'control_unavailable');
});

test('老 daemon 不会打字：说清楚，不假装成功', async t=>{
  const f=await fixture(t);
  const response=await f.post('s',{text:'hi'});
  assert.equal(response.status,409);assert.equal(((await response.json())as any).error.code,'control_unavailable');
});
