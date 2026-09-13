import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createWorkspaceStore} from '../src/index.ts';
const input=(requestId='request')=>({requestId,type:'submit' as const,terminalInstanceId:'instance',generation:'generation',nativeSessionId:'native',text:'hello'});
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'commands-'));const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd:dir});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir};}

test('durable idempotency, queue order and bounded pagination do not merge identical text',t=>{
 const {store,dir}=fixture(t),a=store.aiCommands.enqueue('s',input());
 assert.deepEqual(store.aiCommands.enqueue('s',input()),a);
 assert.throws(()=>store.aiCommands.enqueue('s',{...input(),text:'changed'}),/request_conflict/);
 const b=store.aiCommands.enqueue('s',input('second'));assert.ok(b.seq>a.seq);
 const peer=createWorkspaceStore({dataDir:dir});try{assert.deepEqual(peer.aiCommands.enqueue('s',input()),a);}finally{peer.close();}
 const page=store.aiCommands.list('s',undefined,1);assert.equal(page.items[0].requestId,'second');assert.equal(store.aiCommands.list('s',page.nextCursor!,1).items[0].requestId,'request');
 assert.deepEqual(store.aiCommands.active('s').map(c=>c.requestId),['request','second']);
});
test('cancel, crash recovery and deletion retain text but never resurrect uncertain writes',t=>{
 const {store}=fixture(t);store.aiCommands.enqueue('s',input('queued'));store.aiCommands.enqueue('s',input('writing'));
 store.aiCommands.update('s','writing',['queued'],{status:'writing'});
 assert.throws(()=>store.aiCommands.cancel('s','writing'),/already_writing/);
 store.aiCommands.recoverOwner();assert.equal(store.aiCommands.get('s','queued')?.status,'cancelled');assert.equal(store.aiCommands.get('s','writing')?.status,'uncertain');assert.equal(store.aiCommands.get('s','queued')?.text,'hello');
 assert.equal(store.aiCommands.enqueue('s',input('writing')).status,'uncertain');
 assert.equal(store.aiCommands.cancel('s','queued').status,'cancelled');
 store.deleteSessionRecord('s');
 assert.equal(store.getSessionRecord('s'),null);
 assert.equal(store.aiCommands.list('s').items.length,2,'terminal deletion retains command evidence');
 assert.equal(store.aiCommands.get('s','queued')?.status,'cancelled');
 assert.equal(store.aiCommands.get('s','writing')?.status,'uncertain');
 assert.equal(store.aiCommands.get('s','writing')?.text,'hello');
});

test('terminal deletion invalidates pending commands atomically and preserves accepted native receipts',t=>{
 const {store,dir}=fixture(t);
 for(const id of ['queued','writing','accepted'])store.aiCommands.enqueue('s',input(id));
 store.aiCommands.update('s','writing',['queued'],{status:'writing'});
 store.aiCommands.update('s','accepted',['queued'],{status:'accepted',nativeMessageId:'accepted-native'});
 const db=new DatabaseSync(join(dir,'workspace.sqlite'));
 try {
  db.exec("CREATE TRIGGER reject_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'injected delete failure'); END");
  assert.throws(()=>store.deleteSessionRecord('s'),/injected delete failure/);
  assert.ok(store.getSessionRecord('s'));
  assert.equal(store.aiCommands.get('s','queued')?.status,'queued','outer rollback restores nested command transition');
  assert.equal(store.aiCommands.get('s','writing')?.status,'writing');
  assert.equal(store.aiCommands.get('s','accepted')?.status,'accepted');
  db.exec('DROP TRIGGER reject_session_delete');
  store.deleteSessionRecord('s');
  assert.equal(store.aiCommands.get('s','queued')?.status,'cancelled');
  assert.equal(store.aiCommands.get('s','writing')?.status,'uncertain');
  assert.equal(store.aiCommands.get('s','accepted')?.status,'accepted');
  assert.equal(store.aiCommands.hasAcceptedMessage('native','accepted-native'),true);
 } finally {db.close();}
});
test('limits and controls are rejected before any command record is created',t=>{
 const {store}=fixture(t);
 for(const text of ['', '  ','\x1b[31m','/clear','a\x00b'])assert.throws(()=>store.aiCommands.enqueue('s',{...input(),text}),/invalid_request/);
 assert.throws(()=>store.aiCommands.enqueue('s',{...input(),text:'中'.repeat(6000)}),/too_large/);
 for(let i=0;i<20;i++)store.aiCommands.enqueue('s',input(String(i)));
 assert.throws(()=>store.aiCommands.enqueue('s',input('overflow')),/queue_full/);
 assert.equal(store.aiCommands.enqueue('s',input('0')).requestId,'0');
});

test('one native user record cannot acknowledge two command requests',t=>{
 const {store}=fixture(t);store.aiCommands.enqueue('s',input('a'));store.aiCommands.enqueue('s',input('b'));
 store.aiCommands.update('s','a',['queued'],{status:'accepted',nativeMessageId:'uuid'});
 assert.equal(store.aiCommands.hasAcceptedMessage('native','uuid'),true);
 assert.throws(()=>store.aiCommands.update('s','b',['queued'],{status:'accepted',nativeMessageId:'uuid'}));
 assert.equal(store.aiCommands.get('s','b')?.status,'queued','receipt conflict rolls back command transition');
});
