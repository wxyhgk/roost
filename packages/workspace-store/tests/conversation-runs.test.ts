import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createWorkspaceStore} from '../src/index.ts';

function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'g2-runs-')),store=createWorkspaceStore({dataDir:dir});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.upsertSession({id:'web',cwd:dir});
  const binding=bridge.bind({webSessionId:'web',terminalInstanceId:'instance-a',cliId:'omp',nativeSessionId:'native-a'});
  return {dir,store,bridge,binding,runs:store.conversationRuns};
}
const errorCode=(code:string)=>(e:any)=>e.status===409&&e.code===code;

test('observing an exact live binding is idempotent and rejects a different daemon owner',t=>{
  const f=fixture(t),first=f.runs.observe(f.binding,'owner-a');
  assert.equal(first.state,'active');assert.equal(first.ownerEpoch,1);
  assert.deepEqual(f.runs.observe(f.binding,'owner-a'),first);
  assert.throws(()=>f.runs.observe(f.binding,'owner-b'),errorCode('run_owner_conflict'));
  assert.equal(f.runs.list().length,1);
  assert.equal(f.runs.active(first.conversationId)?.id,first.id);
});

test('owner retirement marks uncertainty and successor gets a larger durable epoch',t=>{
  const f=fixture(t),old=f.runs.observe(f.binding,'owner-a');
  assert.equal(f.runs.retireOtherOwners('owner-b'),1);
  assert.equal(f.runs.get(old.id)?.state,'unknown');
  assert.equal(f.runs.get(old.id)?.endedAt,null,'owner replacement is not proof of native exit');
  const next=f.runs.observe(f.binding,'owner-b');
  assert.notEqual(next.id,old.id);assert.equal(next.sourceId,old.sourceId);assert.equal(next.ownerEpoch,old.ownerEpoch+1);
  const peer=createWorkspaceStore({dataDir:f.dir});
  try{assert.deepEqual(peer.conversationRuns.observe(f.binding,'owner-b'),next);}finally{peer.close();}
  assert.throws(()=>f.runs.observe(f.binding,'owner-a'),errorCode('run_owner_conflict'));
});

test('native A to B to A in one terminal preserves all runs and increments only the returned source epoch',t=>{
  const f=fixture(t),a=f.runs.observe(f.binding,'owner');
  const bBinding=f.bridge.rebind({...f.binding,nativeSessionId:'native-b'},f.binding.generation,f.binding.revision);
  const b=f.runs.observe(bBinding,'owner');
  assert.equal(f.runs.get(a.id)?.state,'ended');assert.equal(f.runs.get(a.id)?.reason,'binding_replaced');
  assert.notEqual(a.conversationId,b.conversationId);assert.equal(b.ownerEpoch,1);
  const aBinding=f.bridge.rebind({...bBinding,nativeSessionId:'native-a'},bBinding.generation,bBinding.revision);
  const resumed=f.runs.observe(aBinding,'owner');
  assert.equal(resumed.conversationId,a.conversationId);assert.equal(resumed.ownerEpoch,2);
  assert.equal(f.runs.get(b.id)?.state,'ended');assert.equal(f.runs.list().filter(x=>x.state==='active').length,1);
  assert.throws(()=>f.runs.observe(f.binding,'owner'),errorCode('run_binding_stale'));
});

test('stale revision, changed terminal identity and closed terminals cannot acquire a run',t=>{
  const f=fixture(t);
  for(const patch of [{revision:f.binding.revision+1},{terminalInstanceId:'forged'},{generation:'old'},{nativeSessionId:'elsewhere'}]) {
    assert.throws(()=>f.runs.observe({...f.binding,...patch},'owner'),errorCode('run_binding_stale'));
  }
  assert.equal(f.runs.list().length,0);
  f.store.setSessionClosed('web',true);
  assert.throws(()=>f.runs.observe(f.binding,'owner'),errorCode('run_binding_stale'));
});

test('terminal deletion ends its run while retaining conversation history and immutable run identity',t=>{
  const f=fixture(t);f.bridge.publish('web',{type:'message',eventId:'retained',content:'survives run'});
  const run=f.runs.observe(f.bridge.get('web')!,'owner');
  f.store.deleteSessionRecord('web');
  assert.equal(f.runs.get(run.id)?.state,'ended');assert.equal(f.runs.active(run.conversationId),undefined);
  assert.equal(f.store.conversations.getMessage(run.conversationId,'retained').event.content,'survives run');
  assert.equal(f.runs.get(run.id)?.sourceId,run.sourceId);
  assert.throws(()=>f.runs.observe(f.binding,'owner'),errorCode('run_binding_stale'));
});

test('a connection without writer capability cannot modify runs or ownership epochs',t=>{
  const f=fixture(t),run=f.runs.observe(f.binding,'owner'),old=new DatabaseSync(join(f.dir,'workspace.sqlite'));
  try {
    assert.throws(()=>old.prepare("UPDATE conversation_runs SET state='ended' WHERE id=?").run(run.id));
    assert.throws(()=>old.exec('DELETE FROM conversation_run_epochs'));
    assert.equal(f.runs.get(run.id)?.state,'active');
  }finally{old.close();}
});
