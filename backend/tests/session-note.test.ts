import './helpers/fake-pty.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {createWorkspaceStore}=await import('@roost/workspace-store');
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createBackendServer}=await import('../src/server.ts');

async function fixture(t:TestContext,noopWriter=false){
 const dir=await mkdtemp(join(tmpdir(),'session-note-'));const store=createWorkspaceStore({dataDir:dir});store.createProject({id:'project',name:'Project'});
 for(const id of ['a','b','c'])store.upsertSession({id,cwd:dir,title:id.toUpperCase()});
 let writerCalls=0;
 if(noopWriter)store.setSessionNote=()=>{writerCalls++;};
 const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
 const server=createBackendServer({auth:false,store,runtime,workspaceRoot:dir});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;let stopped=false;
 const stop=async()=>{if(stopped)return;stopped=true;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.dispose();store.close();};
 t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
 const request=(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const patch=(id:string,body:unknown)=>request('/api/sessions/'+id,'PATCH',body);
 const json=async(path:string)=>{const r=await request(path);assert.equal(r.status,200);return r.json();};
 return{dir,store,runtime,request,patch,json,stop,writerCalls:()=>writerCalls};
}
async function expectPersistedNote(f:Awaited<ReturnType<typeof fixture>>,value:string){
 const response=await f.patch('b',{note:value});assert.equal(response.status,200);
 const reopened=createWorkspaceStore({dataDir:f.dir});try{assert.equal(reopened.loadWorkspace().sessions.find(s=>s.id==='b')!.note,value);}finally{reopened.close();}
}

test('session note is always present and PATCH persists trimmed multiline text through HTTP and a fresh store',async t=>{
 const f=await fixture(t);for(const record of (await f.json('/api/workspace')).sessions){assert.ok(Object.hasOwn(record,'note'));assert.equal(record.note,null);}
 assert.equal((await f.json('/api/sessions/b')).note,null);
 const created=await f.request('/api/sessions','POST',{cwd:f.dir,title:'Created'});assert.equal(created.status,201);const newRecord=await created.json();assert.ok(Object.hasOwn(newRecord,'note'));assert.equal(newRecord.note,null);
 const response=await f.patch('b',{note:' \t计算化学任务\n\n  保留内部缩进\n下一行 \r\n'});assert.equal(response.status,200);const expected='计算化学任务\n\n  保留内部缩进\n下一行';assert.equal((await response.json()).note,expected);
 assert.equal((await f.json('/api/sessions/b')).note,expected);assert.equal((await f.json('/api/workspace')).sessions.find((s:any)=>s.id==='b').note,expected);
 await f.stop();const reopened=createWorkspaceStore({dataDir:f.dir});try{assert.equal(reopened.getSessionRecord('b')!.note,expected);assert.equal(reopened.loadWorkspace().sessions.find(s=>s.id==='b')!.note,expected);}finally{reopened.close();}
});

test('empty and whitespace notes normalize to null; absent note preserves it; exactly 2000 UTF-16 units are allowed',async t=>{
 const f=await fixture(t);
 for(const empty of ['', ' \t\r\n ',null]){await expectPersistedNote(f,'existing note');const response=await f.patch('b',{note:empty});assert.equal(response.status,200);assert.equal((await response.json()).note,null);assert.equal(f.store.getSessionRecord('b')!.note,null);}
 for(const value of ['x'.repeat(2000),'🧪'.repeat(1000)]){assert.equal(value.length,2000);await expectPersistedNote(f,value);}
 const expected=f.store.getSessionRecord('b')!.note;const response=await f.patch('b',{title:'Renamed',projectId:'project',beforeId:'a'});assert.equal(response.status,200);const record=await response.json();assert.equal(record.note,expected);assert.equal(record.title,'Renamed');assert.equal(record.projectId,'project');assert.equal(f.store.loadWorkspace().sessions[0]!.id,'b');
});

test('invalid raw note values return stable 400 before title, project or order changes; unknown session is 404',async t=>{
 const f=await fixture(t);await expectPersistedNote(f,'preserve');const before=f.store.loadWorkspace();
 for(const note of [false,0,{},[],['text'],'x'.repeat(2001),' '.repeat(2001),' '+ 'x'.repeat(2000),'🧪'.repeat(1001)]){
  const response=await f.patch('b',{note,title:'Should not change',projectId:'project',beforeId:'a'});assert.equal(response.status,400);assert.equal((await response.json()).error.code,'invalid_request');assert.deepEqual(f.store.loadWorkspace(),before);
 }
 assert.equal((await f.patch('missing',{note:'value'})).status,404);assert.equal((await f.patch('missing',{note:false})).status,404);assert.deepEqual(f.store.loadWorkspace(),before);
});

test('close, reopen and upsert retain session note while deletion removes it without affecting the notes library',async t=>{
 const f=await fixture(t);f.store.library.notes.create('library-note',{text:'independent durable knowledge'});await expectPersistedNote(f,'terminal-specific task');
 assert.equal((await f.request('/api/sessions/b/close','POST')).status,200);assert.equal(f.store.getSessionRecord('b')!.note,'terminal-specific task');
 assert.equal((await f.request('/api/sessions/b/reopen','POST')).status,200);assert.equal(f.store.getSessionRecord('b')!.note,'terminal-specific task');
 f.store.upsertSession({id:'b',cwd:f.dir,title:'Upsert title',projectId:'project',closed:true});assert.equal(f.store.getSessionRecord('b')!.note,'terminal-specific task');
 f.store.deleteSessionRecord('b');assert.equal(f.store.getSessionRecord('b'),null);assert.equal(f.store.library.notes.get('library-note').text,'independent durable knowledge');
 f.store.upsertSession({id:'b',cwd:f.dir});assert.equal(f.store.getSessionRecord('b')!.note,null,'reusing a removed terminal ID must not resurrect its old note');assert.equal(f.store.library.notes.get('library-note').text,'independent durable knowledge');
});

test('the HTTP persistence assertion catches a disconnected note writer without mutating production source',async t=>{
 const f=await fixture(t,true);
 await assert.rejects(()=>expectPersistedNote(f,'must reach SQLite'),error=>error instanceof assert.AssertionError);
 assert.equal(f.writerCalls(),1,'PATCH must actually reach the temporarily substituted note writer');assert.equal(f.store.getSessionRecord('b')!.note,null);
});
