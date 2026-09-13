import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkspaceStore, LibraryError } from '../src/index.ts';
function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'roost-library-store-'));
  const stores:ReturnType<typeof createWorkspaceStore>[]=[];
  const open=()=>{const store=createWorkspaceStore({dataDir:dir});stores.push(store);return store};
  t.after(()=>{for(const store of stores)store.close();rmSync(dir,{recursive:true,force:true})});
  return {dir,open};
}
const error=(status:number)=>(value:unknown)=>value instanceof LibraryError&&value.status===status;

test('library migration preserves existing workspace/replay and runs once across reopen',t=>{
  const f=fixture(t),path=join(f.dir,'workspace.sqlite'),old=new DatabaseSync(path);
  old.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE terminal_replay(session_id TEXT PRIMARY KEY,raw TEXT NOT NULL DEFAULT '',snapshot TEXT,updated_at INTEGER NOT NULL); INSERT INTO terminal_replay VALUES ('old','RAW','SCREEN',12)");old.close();
  const a=f.open();a.upsertSession({id:'s',cwd:'/tmp'});a.createProject({id:'p'});
  a.library.notes.create('n',{text:'中文\nsecond line'});const info=a.library.info(),workspace=a.loadWorkspace();
  const b=f.open();assert.deepEqual(b.library.info(),info);assert.deepEqual(b.loadWorkspace(),workspace);
  assert.equal(b.getTerminalReplay('old')?.raw,'RAW');assert.equal(b.getTerminalReplay('old')?.snapshot,'SCREEN');
  assert.equal((b.library.notes.get('n') as {text:string}).text,'中文\nsecond line');
  b.deleteSessionRecord('s');b.deleteProjectRecord('p');assert.equal(b.library.notes.get('n').revision,1);
  const db=new DatabaseSync(path);try{assert.equal(db.prepare("SELECT count(*) AS n FROM meta WHERE key='schema.library.v1'").get()?.n,1)}finally{db.close()}
});

test('two connections cannot overwrite the same revision, including update/delete races',t=>{
  const f=fixture(t),a=f.open(),b=f.open();a.library.notes.create('n',{text:''});
  a.library.notes.update('n',1,{text:'first'});
  assert.throws(()=>b.library.notes.update('n',1,{text:'second'}),value=>error(409)(value)&&(value as LibraryError).current!==undefined);
  assert.throws(()=>b.library.notes.remove('n',1),error(409));
  const tomb=b.library.notes.remove('n',2);assert.equal(tomb.revision,3);
  assert.throws(()=>a.library.notes.update('n',2,{text:'resurrect'}),error(410));
  assert.throws(()=>a.library.notes.create('n',{text:''}),error(410));
  assert.deepEqual(a.library.notes.remove('n',2),tomb);
  assert.equal(a.library.notes.list('',50).items.length,0);
  assert.throws(()=>a.library.notes.update('missing',1,{text:''}),error(404));
});

test('create retries are content-idempotent and partial snippet changes preserve other fields',t=>{
  const {open}=fixture(t),store=open(),snippets=store.library.snippets;
  const original=snippets.create('s',{title:'',code:'print("中文")\n',lang:'future_lang'});
  assert.equal(original.created,true);assert.deepEqual(snippets.create('s',{title:'',code:'print("中文")\n',lang:'future_lang'}),{created:false,record:original.record});
  assert.throws(()=>snippets.create('s',{title:'other',code:''}),error(409));
  const saved=snippets.update('s',1,{title:'命令'});
  assert.equal((saved as {code:string}).code,'print("中文")\n');assert.equal((saved as {lang:string}).lang,'future_lang');
  assert.throws(()=>snippets.update('s',1,{title:'命令'}),error(409));
});

test('search is literal, ASCII case-insensitive, and cursor ordering handles equal timestamps',t=>{
  const {open}=fixture(t),store=open();
  store.library.importBatch({sourceId:'browser',batchId:'one',notes:[
    {id:'a',text:'Alpha 100%_\\ 中文',createdAt:10,updatedAt:20},
    {id:'b',text:'alpha other 中文',createdAt:10,updatedAt:20},
    {id:'c',text:'\n \n标题\n'+'x'.repeat(300),createdAt:10,updatedAt:20},
  ],snippets:[]});
  const notes=store.library.notes;
  assert.deepEqual(notes.list('ALPHA',50).items.map(n=>n.id),['b','a']);
  for(const q of ['%','_','\\','100%_\\'])assert.deepEqual(notes.list(q,50).items.map(n=>n.id),['a']);
  assert.equal(notes.list('中文',50).items.length,2);
  const page=notes.list('',2);assert.deepEqual(page.items.map(n=>n.id),['c','b']);
  assert.equal(page.items[0].title,'标题');assert.equal(page.items[0].summary.length,160);assert.ok(!('text' in page.items[0]));
  assert.deepEqual(notes.list('',2,page.next!).items.map(n=>n.id),['a']);
});

test('import ledger handles retries, conflicts, tombstones and invalid legacy times',t=>{
  const {open}=fixture(t),store=open(),library=store.library;
  library.notes.create('conflict',{text:'server'});library.notes.create('dead',{text:'gone'});library.notes.remove('dead',1);
  const batch={sourceId:'old-browser',batchId:'batch-1',notes:[
    {id:'old-1',text:'saved',createdAt:123,updatedAt:456},
    {id:'bad-time',text:'saved',createdAt:-1,updatedAt:'invalid'},
    {id:'conflict',text:'local'},{id:'dead',text:'gone'},
  ],snippets:[{id:'old-1',title:'',code:''}]};
  const result=library.importBatch(batch);assert.deepEqual(result.notes.map((n:{status:string})=>n.status),['created','created','conflict','deleted']);
  assert.equal(library.notes.get('old-1').createdAt,123);assert.ok(library.notes.get('bad-time').createdAt>0);
  library.notes.update('old-1',1,{text:'later'});
  assert.deepEqual(library.importBatch(batch),result);
  assert.throws(()=>library.importBatch({...batch,notes:[]}),error(409));
  const another=library.importBatch({...batch,batchId:'batch-2'});assert.equal(another.notes[0].status,'conflict');
  assert.equal((library.notes.get('conflict') as {text:string}).text,'server');
});

test('failed import rolls back both content and ledger, then same batch can retry',t=>{
  const f=fixture(t),store=f.open(),db=new DatabaseSync(join(f.dir,'workspace.sqlite'));
  const batch={sourceId:'browser',batchId:'retry',notes:[{id:'a',text:'ok'},{id:'b',text:'fail'}],snippets:[]};
  try {
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON notes WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    assert.throws(()=>store.library.importBatch(batch),/injected failure/);
    assert.equal(store.library.notes.list('',50).items.length,0);assert.equal(db.prepare('SELECT count(*) AS n FROM library_imports').get()?.n,0);
    db.exec('DROP TRIGGER fail_import');assert.equal(store.library.importBatch(batch).notes.length,2);
  }finally{db.close()}
});

test('import commit includes the ledger: ledger failure rolls back created records',t=>{
  const f=fixture(t),store=f.open(),db=new DatabaseSync(join(f.dir,'workspace.sqlite'));
  const batch={sourceId:'browser',batchId:'ledger',notes:[{id:'a',text:'saved'}],snippets:[]};
  try{
    db.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON library_imports BEGIN SELECT RAISE(ABORT,'ledger unavailable'); END");
    assert.throws(()=>store.library.importBatch(batch),/ledger unavailable/);
    assert.throws(()=>store.library.notes.get('a'),error(404));
    db.exec('DROP TRIGGER fail_ledger');assert.equal(store.library.importBatch(batch).notes[0].status,'created');
  }finally{db.close()}
});

test('closing every connection and reopening retains bodies, tombstones, identity and import ledger',t=>{
  const f=fixture(t),first=createWorkspaceStore({dataDir:f.dir});
  const batch={sourceId:'browser',batchId:'persist',notes:[{id:'saved',text:'持久正文'}],snippets:[{id:'deleted',title:'old',code:'pwd'}]};
  const result=first.library.importBatch(batch),identity=first.library.info();
  const tomb=first.library.snippets.remove('deleted',1);first.close();
  const reopened=f.open();
  assert.deepEqual(reopened.library.info(),identity);
  assert.equal((reopened.library.notes.get('saved') as {text:string}).text,'持久正文');
  assert.deepEqual(reopened.library.snippets.remove('deleted',1),tomb);
  assert.deepEqual(reopened.library.importBatch(batch),result);
});
