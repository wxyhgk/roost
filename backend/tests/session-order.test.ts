import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import './helpers/fake-pty.ts';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-session-order-'));
  const store = createWorkspaceStore({dataDir: dir});
  store.createProject({id:'p'});
  for (const id of ['a','b','c','d']) store.upsertSession({id,cwd:dir,closed:id==='c',projectId:id==='a'||id==='d'?'p':null});
  const runtime = createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  const server = createBackendServer({ auth: false,store,runtime,workspaceRoot:dir});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const db = new DatabaseSync(join(dir,'workspace.sqlite'));
  t.after(async()=>{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    runtime.dispose();db.close();store.close();rmSync(dir,{recursive:true,force:true});
  });
  return {store,db,dir,
    patch:(id:string,body:unknown)=>fetch(`${base}/api/sessions/${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),
    workspace:async()=>await (await fetch(base+'/api/workspace')).json(),
    patchWorkspace:(body:unknown)=>fetch(base+'/api/workspace',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),
    rows:()=>db.prepare('SELECT id, seq FROM sessions ORDER BY seq').all(),
  };
}

for (const [name,id,beforeId,expected] of [
  ['middle to first','b','a',['b','a','c','d']],
  ['first to end','a',null,['b','c','d','a']],
  ['last to middle','d','b',['a','d','b','c']],
  ['closed session can move','c','a',['c','a','b','d']],
] as const) test(name,async t=>{
  const f=await fixture(t);const before=f.store.getSessionRecord(id);
  const response=await f.patch(id,{beforeId});assert.equal(response.status,200);
  assert.deepEqual(await response.json(),before);
  assert.deepEqual((await f.workspace()).sessions.map((s:{id:string})=>s.id),expected);
  assert.deepEqual(f.rows().map(row=>row.seq),[1,2,3,4]);
  const reopened=createWorkspaceStore({dataDir:f.dir});
  try{assert.deepEqual(reopened.loadWorkspace().sessions.map(s=>s.id),expected)}finally{reopened.close()}
});

test('missing session is 404; invalid beforeId is 400 without changing title, grouping or order',async t=>{
  const f=await fixture(t);const before=f.store.loadWorkspace();
  assert.equal((await f.patch('unknown',{beforeId:'a'})).status,404);
  for(const beforeId of ['unknown','',false,5,{},[]]) {
    assert.equal((await f.patch('b',{beforeId,title:'changed',projectId:'p'})).status,400);
    assert.deepEqual(f.store.loadWorkspace(),before);
  }
});

test('self-reference is an idempotent no-op; omitted key preserves order and existing PATCH fields',async t=>{
  const f=await fixture(t);const rows=f.rows();
  for(let i=0;i<2;i++)assert.equal((await f.patch('b',{beforeId:'b'})).status,200);
  assert.deepEqual(f.rows(),rows);
  const patched=await f.patch('b',{title:'Renamed',projectId:'p'});
  assert.equal(patched.status,200);assert.equal((await patched.json()).title,'Renamed');
  assert.deepEqual(f.rows(),rows);
  assert.equal((await f.patch('b',{beforeId:'a',projectId:null,title:'Moved'})).status,200);
  assert.equal(f.store.getSessionRecord('b')?.projectId,null);
  assert.equal(f.store.getSessionRecord('b')?.title,'Moved');
  assert.deepEqual((await f.workspace()).sessions.map((s:{id:string})=>s.id),['b','a','c','d']);
  f.store.upsertSession({id:'new',cwd:f.dir});
  assert.equal((await f.workspace()).sessions.at(-1).id,'new');
});

test('renumber is atomic if a database write fails',async t=>{
  const f=await fixture(t);const rows=f.rows();
  f.db.exec("CREATE TRIGGER fail_reorder BEFORE UPDATE OF seq ON sessions WHEN NEW.id = 'b' BEGIN SELECT RAISE(ABORT, 'injected reorder failure'); END");
  assert.throws(()=>f.store.reorderSession('d','a'),/injected reorder failure/);
  assert.deepEqual(f.rows(),rows);
});

test('pinned sessions persist across connections, reject non-strings and drop deleted sessions',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.workspace()).pinnedSessionIds,[]);
  const response=await f.patchWorkspace({pinnedSessionIds:['d','a']});
  assert.equal(response.status,200);
  // 顺序是用户拖出来的置顶次序，不能被规范化掉。
  assert.deepEqual((await response.json()).pinnedSessionIds,['d','a']);
  assert.deepEqual((await f.workspace()).pinnedSessionIds,['d','a']);
  const reopened=createWorkspaceStore({dataDir:f.dir});
  try{assert.deepEqual(reopened.loadWorkspace().pinnedSessionIds,['d','a'])}finally{reopened.close()}
  await f.patchWorkspace({pinnedSessionIds:['b',7,null,{},'c']});
  assert.deepEqual((await f.workspace()).pinnedSessionIds,['b','c']);
  // 省略该键不得清空既有置顶——前端每次只 PATCH 自己改动的那一个字段。
  await f.patchWorkspace({selectedId:'a'});
  assert.deepEqual((await f.workspace()).pinnedSessionIds,['b','c']);
  f.store.deleteSessionRecord('b');
  assert.deepEqual((await f.workspace()).pinnedSessionIds,['c']);
});
