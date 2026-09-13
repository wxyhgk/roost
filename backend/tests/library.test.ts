import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import './helpers/fake-pty.ts';
const {createWorkspaceStore}=await import('@roost/workspace-store');
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');
async function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'roost-library-http-')),store=createWorkspaceStore({dataDir:dir});
  const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  const server=createBackendServer({ auth: false,store,runtime,workspaceRoot:dir});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));runtime.dispose();store.close();rmSync(dir,{recursive:true,force:true})});
  const request=(method:string,path:string,body?:unknown)=>fetch(base+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {dir,store,request,base};
}
for(const kind of ['notes','snippets'] as const)test(`${kind} CRUD, create retries, concurrent editors and tombstones`,async t=>{
  const f=await fixture(t),id=randomUUID(),path=`/api/${kind}/${id}`;
  const content=kind==='notes'?{text:'中文\nbody'}:{title:'中文',lang:'my_new_lang',code:'a\nb'};
  const created=await f.request('POST',`/api/${kind}`,{id,...content});assert.equal(created.status,201);const original=await created.json();assert.equal(original.revision,1);
  assert.equal((await f.request('POST',`/api/${kind}`,{id,...content})).status,200);
  const changes=kind==='notes'?{text:'changed'}:{code:'changed'};
  assert.equal((await f.request('POST',`/api/${kind}`,{id,...content,...changes})).status,409);
  const writes=await Promise.all([f.request('PATCH',path,{revision:1,...changes}),f.request('PATCH',path,{revision:1,...changes})]);
  assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);
  const conflict=await writes.find(r=>r.status===409)!.json();assert.equal(conflict.error.code,'revision_conflict');assert.equal(conflict.current.revision,2);
  assert.equal((await f.request('DELETE',path,{revision:1})).status,409);
  const deleted=await f.request('DELETE',path,{revision:2});assert.equal(deleted.status,200);const tomb=await deleted.json();assert.equal(tomb.revision,3);
  assert.deepEqual(await (await f.request('DELETE',path,{revision:2})).json(),tomb);
  for(const method of ['GET','PATCH'])assert.equal((await f.request(method,path,method==='PATCH'?{revision:2,...changes}:undefined)).status,410);
  assert.equal((await f.request('POST',`/api/${kind}`,{id,...content})).status,410);
  assert.deepEqual((await (await f.request('GET',`/api/${kind}`)).json()).items,[]);
});

test('validation rejects unknown fields, immutable fields, nulls, invalid revisions and IDs',async t=>{
  const f=await fixture(t),id=randomUUID(),path='/api/notes/'+id;
  await f.request('POST','/api/notes',{id,text:''});
  for(const body of [{text:'no revision'},{revision:null,text:''},{revision:0,text:''},{revision:1.1,text:''},{revision:1,text:null},{revision:1,id:'other',text:''},{revision:1,createdAt:1,text:''},{revision:1,extra:true,text:''},{revision:1}]){
    const response=await f.request('PATCH',path,body);assert.equal(response.status,400);assert.ok((await response.json()).error.code);
  }
  assert.equal((await f.request('POST','/api/notes',{id:'legacy-id',text:''})).status,400);
  assert.equal((await f.request('GET','/api/notes/%E0%A4%A')).status,400);
  assert.equal((await f.request('GET','/api/notes/'+randomUUID())).status,404);
  assert.equal((await f.request('DELETE',path,{})).status,400);
  assert.equal((await f.request('PATCH',path,{revision:1,text:''})).status,200);
});

test('listing omits bodies, supports literal search and validates filter-bound cursor',async t=>{
  const f=await fixture(t);
  await f.request('POST','/api/library/import',{sourceId:'browser',batchId:'one',notes:[{id:'a',text:'Alpha %_\\ 中文',updatedAt:10},{id:'b',text:'alpha 中文',updatedAt:10},{id:'c',text:'else',updatedAt:10}],snippets:[{id:'s',title:'ALPHA',code:'中文',lang:'future'}]});
  const page=await (await f.request('GET','/api/notes?q=ALPHA&limit=1')).json();assert.equal(page.items[0].id,'b');assert.ok(!('text' in page.items[0]));assert.ok(page.nextCursor);
  const next=await (await f.request('GET','/api/notes?q=ALPHA&limit=1&cursor='+page.nextCursor)).json();assert.equal(next.items[0].id,'a');assert.equal(next.nextCursor,null);
  assert.equal((await f.request('GET','/api/notes?q=other&cursor='+page.nextCursor)).status,400);
  assert.equal((await f.request('GET','/api/snippets?q=ALPHA&cursor='+page.nextCursor)).status,400);
  for(const query of ['limit=0','limit=101','limit=NaN','cursor=oops','q=a&q=b'])assert.equal((await f.request('GET','/api/notes?'+query)).status,400);
  const literal=await (await f.request('GET','/api/notes?q='+encodeURIComponent('%_\\'))).json();assert.deepEqual(literal.items.map((x:{id:string})=>x.id),['a']);
  const snippets=await (await f.request('GET','/api/snippets?q=中文')).json();assert.equal(snippets.items[0].lang,'future');assert.ok(!('code' in snippets.items[0]));
});

test('decoded UTF-8 limits allow escaped JSON and reject oversized bodies and batches',async t=>{
  const f=await fixture(t);
  const escaped='\u0001'.repeat(1024*1024);
  assert.equal((await f.request('POST','/api/notes',{id:randomUUID(),text:escaped})).status,201);
  for(const text of ['x'.repeat(1024*1024+1),'中'.repeat(350000)])assert.equal((await f.request('POST','/api/notes',{id:randomUUID(),text})).status,413);
  assert.equal((await f.request('POST','/api/snippets',{id:randomUUID(),title:'x'.repeat(257),code:''})).status,413);
  assert.equal((await f.request('POST','/api/snippets',{id:randomUUID(),title:'',code:'',lang:'x'.repeat(65)})).status,413);
  assert.equal((await f.request('GET','/api/notes?q='+'x'.repeat(201))).status,413);
  assert.equal((await f.request('POST','/api/library/import',{sourceId:'b',batchId:'big',notes:Array.from({length:101},(_,i)=>({id:String(i),text:''})),snippets:[]})).status,413);
  assert.equal((await f.request('POST','/api/library/import',{sourceId:'b',batchId:'bytes',notes:[],snippets:[],padding:'x'.repeat(8*1024*1024)})).status,413);
});

test('migration retries return original results, preserve conflicts and reject whole invalid batches',async t=>{
  const f=await fixture(t);
  const info=await (await f.request('GET','/api/library/info')).json();assert.ok(info.libraryId);
  const batch={sourceId:'browser',batchId:'first',notes:[{id:'legacy-1',text:'local',createdAt:123,updatedAt:-1}],snippets:[]};
  const first=await (await f.request('POST','/api/library/import',batch)).json();assert.equal(first.libraryId,info.libraryId);assert.equal(first.notes[0].status,'created');
  assert.equal((await (await f.request('GET','/api/notes/legacy-1')).json()).createdAt,123);
  await f.request('PATCH','/api/notes/legacy-1',{revision:1,text:'server'});
  assert.deepEqual(await (await f.request('POST','/api/library/import',batch)).json(),first);
  assert.equal((await f.request('POST','/api/library/import',{...batch,notes:[]})).status,409);
  const conflict=await (await f.request('POST','/api/library/import',{...batch,batchId:'second'})).json();assert.equal(conflict.notes[0].status,'conflict');
  const bad=await f.request('POST','/api/library/import',{...batch,batchId:'invalid',notes:[{id:'good',text:''},{id:'bad',text:null}]});assert.equal(bad.status,400);assert.match((await bad.json()).error.message,/notes\[1\].text/);
  assert.equal((await f.request('GET','/api/notes/good')).status,404);
  await f.request('DELETE','/api/notes/legacy-1',{revision:2});
  const dead=await (await f.request('POST','/api/library/import',{...batch,batchId:'third'})).json();assert.equal(dead.notes[0].status,'deleted');
});

test('database contention returns structured 503 without acknowledging a save', {timeout:15000},async t=>{
  const f=await fixture(t),locker=new DatabaseSync(join(f.dir,'workspace.sqlite'));
  try {
    locker.exec('BEGIN IMMEDIATE');
    const response=await f.request('POST','/api/notes',{id:randomUUID(),text:'blocked'});
    assert.equal(response.status,503);assert.equal((await response.json()).error.code,'storage_unavailable');
    locker.exec('ROLLBACK');assert.equal(f.store.library.notes.list('',50).items.length,0);
  }finally{locker.close()}
});

test('failed storage write returns an error and leaves revision and content unchanged',async t=>{
  const f=await fixture(t),id=randomUUID();await f.request('POST','/api/notes',{id,text:'original'});
  const db=new DatabaseSync(join(f.dir,'workspace.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_save BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");
    const result=await f.request('PATCH','/api/notes/'+id,{revision:1,text:'new'});
    assert.equal(result.status,500);assert.equal((await result.json()).error.code,'internal_error');
    const saved=await (await f.request('GET','/api/notes/'+id)).json();assert.equal(saved.revision,1);assert.equal(saved.text,'original');
  }finally{db.close()}
});
