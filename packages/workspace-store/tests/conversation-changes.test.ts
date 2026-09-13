import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createWorkspaceStore} from '../src/index.ts';

function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'g2-changes-')),store=createWorkspaceStore({dataDir:dir});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  const db=new DatabaseSync(join(dir,'workspace.sqlite'));
  t.after(()=>{db.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const ids=Object.fromEntries(['A','B'].map(name=>{store.upsertSession({id:name,cwd:dir});const b=bridge.bind({webSessionId:name,terminalInstanceId:name,cliId:'omp',nativeSessionId:name});const r=store.conversationRuns.observe(b,'owner');return[name,r.conversationId];})) as Record<'A'|'B',string>;
  function append(id:string,entityId:string,payload:Record<string,unknown>={}) {
    db.prepare('INSERT INTO conversation_changes(conversation_id,kind,entity_id,entity_revision,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(id,'test.updated',entityId,1,JSON.stringify(payload),Date.now());
  }
  return {dir,store,bridge,db,...ids,changes:store.conversationChanges,append};
}
const seq=(cursor:string)=>JSON.parse(Buffer.from(cursor,'base64url').toString()).seq as number;
const resync=(e:any)=>e.status===409&&e.code==='resync_required';

test('business changes and their log entries commit together and rollback together',t=>{
  const f=fixture(t),record=f.store.conversations.get(f.A),cursor=f.changes.snapshotCursor(f.A);
  f.db.exec("CREATE TRIGGER fail_change BEFORE INSERT ON conversation_changes BEGIN SELECT RAISE(ABORT,'change write fault'); END");
  assert.throws(()=>f.store.conversations.patch(f.A,{revision:record.revision,title:'Must roll back'}),/change write fault/);
  assert.equal(f.store.conversations.get(f.A).title,record.title);
  assert.deepEqual(f.changes.read(f.A,{cursor}).items,[]);
  f.db.exec('DROP TRIGGER fail_change');
  const updated=f.store.conversations.patch(f.A,{revision:record.revision,title:'Committed'});
  const page=f.changes.read(f.A,{cursor});
  assert.ok(page.items.some(x=>x.kind==='conversation.updated'&&x.entityRevision===updated.revision));
});

test('peer envelope and delivery changes reach both sender and recipient without copying private body',t=>{
  const f=fixture(t),a=f.store.conversationRuns.active(f.A)!,ca=f.changes.snapshotCursor(f.A),cb=f.changes.snapshotCursor(f.B);
  const saved=f.store.peerMessages.send({kind:'agent',conversationId:f.A,runId:a.id},{recipientId:f.B,requestId:'one',text:'PRIVATE_SYNTHETIC_BODY'});
  for(const [id,cursor] of [[f.A,ca],[f.B,cb]]) {
    const page=f.changes.read(id!,{cursor});
    assert.ok(page.items.some(x=>x.kind==='peer.message.updated'&&x.entityId===saved.message.id));
    assert.ok(page.items.some(x=>x.kind==='peer.delivery.updated'&&x.entityId===saved.message.id));
    assert.ok(!JSON.stringify(page.items).includes('PRIVATE_SYNTHETIC_BODY'));
  }
});

test('filtered pagination is gap aware, monotonic and resumes without duplicates across reopen',t=>{
  const f=fixture(t),cursor=f.changes.snapshotCursor(f.A);
  f.append(f.B,'b1');f.append(f.A,'a1');f.append(f.B,'b2');f.append(f.A,'a2');f.append(f.A,'a3');f.append(f.B,'b3');
  const first=f.changes.read(f.A,{cursor,limit:2});assert.equal(first.hasMore,true);
  assert.deepEqual(first.items.map(x=>x.entityId),['a1','a2']);
  const reopened=createWorkspaceStore({dataDir:f.dir});
  try {
    const second=reopened.conversationChanges.read(f.A,{cursor:first.cursor,limit:2});
    assert.deepEqual(second.items.map(x=>x.entityId),['a3']);assert.equal(second.hasMore,false);
    assert.ok(seq(second.cursor)>second.items[0]!.seq,'caught up cursor advances past filtered B rows');
    assert.deepEqual(reopened.conversationChanges.read(f.A,{cursor:second.cursor}).items,[]);
  }finally{reopened.close();}
});

test('pruned cursors require resync and deleting all log rows does not rewind sequence',t=>{
  const f=fixture(t),before=f.changes.snapshotCursor(f.A);
  for(let i=0;i<5;i++)f.append(f.A,'event-'+i);
  const latest=f.changes.snapshotCursor(f.A),result=f.changes.prune(2);
  assert.ok(result.deleted>0);assert.throws(()=>f.changes.read(f.A,{cursor:before}),resync);
  const floorCursor=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(latest,'base64url').toString()),seq:result.retainedFloor})).toString('base64url');
  assert.equal(f.changes.read(f.A,{cursor:floorCursor}).items.length,2,'floor itself is a valid last-scanned position');
  f.changes.prune(0);assert.deepEqual(f.changes.read(f.A,{cursor:latest}).items,[]);
  f.append(f.A,'after-prune');const after=f.changes.read(f.A,{cursor:latest});
  assert.equal(after.items[0]!.entityId,'after-prune');assert.ok(seq(after.cursor)>seq(latest));
});

test('conversation and lineage mismatches are rejected rather than silently skipping history',t=>{
  const f=fixture(t),cursor=f.changes.snapshotCursor(f.A);
  assert.throws(()=>f.changes.read(f.B,{cursor}),resync);
  for(const replacement of [{lineage:'other-db'},{seq:seq(cursor)+999},{seq:-1},{v:999}]) {
    const tampered=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(cursor,'base64url').toString()),...replacement})).toString('base64url');
    assert.throws(()=>f.changes.read(f.A,{cursor:tampered}),resync);
  }
  assert.throws(()=>f.changes.read(f.A,{cursor:'broken'}),resync);
  assert.throws(()=>f.changes.read(f.A,{limit:0}),(e:any)=>e.code==='invalid_request');
});

test('change pages obey byte budget and a snapshot cursor is paired with saved data',t=>{
  const f=fixture(t),snapshot=f.store.conversationSnapshot(f.A);
  assert.equal(snapshot.conversation.id,f.A);assert.equal(snapshot.messages.items.length,0);
  for(let i=0;i<3;i++)f.append(f.A,'large-'+i,{text:'x'.repeat(180000)});
  const first=f.changes.read(f.A,{cursor:snapshot.cursor,limit:200});
  assert.equal(first.items.length,2);assert.equal(first.hasMore,true);
  assert.ok(Buffer.byteLength(JSON.stringify(first))<512*1024);
  const next=f.changes.read(f.A,{cursor:first.cursor,limit:200});assert.equal(next.items.length,1);
  f.bridge.publish('A',{type:'message',eventId:'history',content:'snapshot body'});
  const after=f.store.conversationSnapshot(f.A);
  assert.equal(after.messages.items[0]!.event.content,'snapshot body');
  assert.deepEqual(f.changes.read(f.A,{cursor:after.cursor}).items,[]);
});

test('concurrent child commit between snapshot reads cannot place a new cursor over unseen inbox data',t=>{
  const f=fixture(t),original=f.store.conversations.get;
  let injected=false;
  f.store.conversations.get=id=>{
    const value=original(id);
    if(!injected) {
      injected=true;
      const storeUrl=new URL('../src/index.ts',import.meta.url).href;
      const code=`import {createWorkspaceStore} from ${JSON.stringify(storeUrl)};const store=createWorkspaceStore({dataDir:process.argv[1]});try{store.peerMessages.send({kind:'user'},{recipientId:process.argv[2],requestId:'during-snapshot',text:'child committed'});}finally{store.close();}`;
      const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code,f.dir,f.A],{encoding:'utf8',timeout:5000});
      assert.equal(child.status,0,child.stderr);
    }
    return value;
  };
  try {
    const snapshot=f.store.conversationSnapshot(f.A);
    assert.equal(snapshot.inbox.items.length,0,'snapshot remains in the read view established before child commit');
    assert.equal(f.store.peerMessages.inbox(f.A).items.length,1);
    assert.ok(f.changes.read(f.A,{cursor:snapshot.cursor}).items.some(x=>x.kind==='peer.message.updated'),'child update remains after snapshot cursor and can be replayed');
  }finally{f.store.conversations.get=original;}
});
