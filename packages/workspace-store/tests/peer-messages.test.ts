import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import {createWorkspaceStore} from '../src/index.ts';
import type {PeerDelivery,PeerActor} from '../src/peer-types.ts';

function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'g2-peer-')),store=createWorkspaceStore({dataDir:dir});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const participants=Object.fromEntries(['A','B','C'].map(name=>{
    store.upsertSession({id:name,cwd:dir});
    const binding=bridge.bind({webSessionId:name,terminalInstanceId:'instance-'+name,cliId:'omp',nativeSessionId:'native-'+name});
    const run=store.conversationRuns.observe(binding,'owner');
    return [name,{binding,run,id:run.conversationId,actor:{kind:'agent' as const,conversationId:run.conversationId,runId:run.id}}];
  })) as Record<'A'|'B'|'C',{binding:ReturnType<typeof bridge.bind>;run:ReturnType<typeof store.conversationRuns.observe>;id:string;actor:Extract<PeerActor,{kind:'agent'}>}>;
  const send=(from:'A'|'B'|'C',to:'A'|'B'|'C',requestId='request',text='hello',inReplyTo?:string)=>store.peerMessages.send(participants[from].actor,{recipientId:participants[to].id,requestId,text,inReplyTo});
  function command(d:PeerDelivery,text='hello') {
    return store.aiCommands.enqueue(d.commandSessionId!,{requestId:d.commandRequestId,type:'submit',terminalInstanceId:d.terminalInstanceId!,generation:d.generation!,nativeSessionId:d.nativeSessionId!,text});
  }
  return {dir,store,bridge,...participants,peer:store.peerMessages,send,command};
}
const code=(name:string)=>(err:any)=>err.code===name;

test('sender scoped idempotency survives new runs and rejects changed payload without merging equal text',t=>{
  const f=fixture(t),original=f.send('A','B');
  assert.deepEqual(f.send('A','B'),original);
  assert.throws(()=>f.send('A','C'),code('request_conflict'));
  assert.throws(()=>f.send('A','B','request','changed'),code('request_conflict'));
  const independent=f.send('A','B','second','hello');assert.notEqual(independent.message.id,original.message.id);
  const c=f.send('C','B');assert.notEqual(c.message.id,original.message.id);
  f.store.conversationRuns.endTerminal('A','test_restart');
  const next=f.store.conversationRuns.observe(f.A.binding,'owner');
  assert.notEqual(next.id,f.A.run.id);
  assert.throws(()=>f.send('A','B'),code('run_unavailable'),'old sender cannot use idempotency to bypass revoked run');
  const retried=f.peer.send({...f.A.actor,runId:next.id},{recipientId:f.B.id,requestId:'request',text:'hello'});
  assert.equal(retried.message.id,original.message.id);
  assert.equal(retried.message.senderRunId,f.A.run.id,'immutable sender run describes original send');
  assert.equal(f.peer.inbox(f.B.id).items.length,3);
});

test('replies return from the original recipient to its original sender, and ordinary output is not forwarded',t=>{
  const f=fixture(t),original=f.send('A','B');
  const reply=f.send('B','A','reply','answer',original.message.id);
  assert.equal(reply.message.inReplyTo,original.message.id);
  for(const [from,to] of [['C','A'],['B','C'],['A','B']] as const)assert.throws(()=>f.send(from,to,'bad-'+from+to,'bad reply',original.message.id),code('invalid_reply'));
  assert.throws(()=>f.send('A','A','self'),code('self_send_forbidden'));
  f.bridge.publish('B',{type:'message',eventId:'native-assistant',role:'assistant',content:'normal answer'});
  assert.equal(f.peer.inbox(f.A.id).items.length,1);
  assert.equal(f.peer.inbox(f.C.id).items.length,0);
  assert.equal(f.peer.outbox(f.B.id).items.length,1);
});

test('FIFO blocks later requests and unresolved native submission until proven acceptance',t=>{
  const f=fixture(t),one=f.send('A','B','one'),two=f.send('C','B','two');
  assert.ok(two.delivery.enqueueSeq>one.delivery.enqueueSeq);
  assert.throws(()=>f.peer.claimDelivery(two.delivery.id,f.B.run),code('recipient_blocked'));
  const first=f.peer.claimDelivery(one.delivery.id,f.B.run);
  assert.equal(first.state,'dispatching');
  const uncertain=f.peer.markUncertain(first.id,'lost_ipc_response');assert.equal(uncertain.state,'uncertain');
  assert.throws(()=>f.peer.claimDelivery(two.delivery.id,f.B.run),code('recipient_blocked'));
  const c=f.command(first),accepted={...c,status:'accepted' as const,writtenAt:Date.now(),nativeMessageId:'native-receipt'};
  const done=f.peer.finishFromCommand(first.id,accepted);assert.equal(done.state,'accepted');
  assert.equal(f.peer.finishFromCommand(first.id,accepted).revision,done.revision,'late duplicate proof does not reproject');
  assert.equal(f.peer.claimDelivery(two.delivery.id,f.B.run).state,'dispatching');
});

test('full target run claim and binding must match before changing a queued delivery',t=>{
  const f=fixture(t),message=f.send('A','B');
  for(const patch of [{ownerEpoch:f.B.run.ownerEpoch+1},{daemonInstanceId:'other'},{sourceId:f.C.run.sourceId},{terminalInstanceId:'changed'}]) {
    assert.throws(()=>f.peer.claimDelivery(message.delivery.id,{...f.B.run,...patch}),code('run_unavailable'));
    assert.equal(f.peer.get(message.message.id).delivery.state,'queued');
  }
  const b=f.bridge.get('B')!;
  f.bridge.rebind({...b,nativeSessionId:'native-C-other'},b.generation,b.revision);
  assert.throws(()=>f.peer.claimDelivery(message.delivery.id,f.B.run),code('run_unavailable'));
  assert.equal(f.peer.get(message.message.id).delivery.targetRunId,null);
});

test('command acceptance requires exact input and native receipt, and receipts cannot acknowledge two deliveries',t=>{
  const f=fixture(t),one=f.send('A','B','one'),two=f.send('A','B','two');
  const first=f.peer.claimDelivery(one.delivery.id,f.B.run),c=f.command(first);
  assert.throws(()=>f.peer.finishFromCommand(first.id,{...c,status:'accepted',writtenAt:Date.now(),nativeMessageId:null}),code('receipt_missing'));
  assert.throws(()=>f.peer.finishFromCommand(first.id,{...c,text:'different',status:'accepted',writtenAt:Date.now(),nativeMessageId:'receipt'}),code('command_mismatch'));
  assert.throws(()=>f.peer.finishFromCommand(first.id,{...c,generation:'old',status:'accepted',writtenAt:Date.now(),nativeMessageId:'receipt'}),code('command_mismatch'));
  f.peer.finishFromCommand(first.id,{...c,status:'accepted',writtenAt:Date.now(),nativeMessageId:'receipt'});
  const second=f.peer.claimDelivery(two.delivery.id,f.B.run),c2=f.command(second);
  assert.throws(()=>f.peer.finishFromCommand(second.id,{...c2,status:'accepted',writtenAt:Date.now(),nativeMessageId:'receipt'}),code('receipt_conflict'));
  assert.equal(f.peer.getDelivery(second.id).state,'dispatching');
  const toC=f.send('A','C','to-c'),dc=f.peer.claimDelivery(toC.delivery.id,f.C.run),cc=f.command(dc);
  assert.equal(f.peer.finishFromCommand(dc.id,{...cc,status:'accepted',writtenAt:Date.now(),nativeMessageId:'receipt'}).state,'accepted','other source may reuse native receipt ID');
});

test('cancel and trash respect dispatch boundary, preserve retries, and never silently requeue attempted messages',t=>{
  const f=fixture(t),one=f.send('A','B','one');
  assert.equal(f.peer.cancel(one.delivery.id).state,'cancelled');
  assert.equal(f.peer.cancel(one.delivery.id).revision,2);
  assert.throws(()=>f.peer.claimDelivery(one.delivery.id,f.B.run),code('already_dispatching'));
  const two=f.send('A','B','two'),claimed=f.peer.claimDelivery(two.delivery.id,f.B.run);
  assert.throws(()=>f.peer.cancel(two.delivery.id),code('already_dispatching'));
  const b=f.store.conversations.get(f.B.id);f.store.conversations.patch(b.id,{revision:b.revision,trashed:true});
  assert.throws(()=>f.send('A','B','new'),code('conversation_trashed'));
  assert.equal(f.send('A','B','two').message.id,two.message.id,'existing logical request remains queryable after recipient trash');
  const command=f.command(claimed);
  assert.equal(f.peer.finishFromCommand(claimed.id,{...command,status:'cancelled',writtenAt:Date.now()}).state,'uncertain');
  assert.equal(f.peer.queued(f.B.id).length,0);
});

test('terminal deletion preserves inbox/outbox and attempted receipt while new offline mail remains queued',t=>{
  const f=fixture(t),one=f.send('A','B'),claimed=f.peer.claimDelivery(one.delivery.id,f.B.run),c=f.command(claimed);
  f.peer.finishFromCommand(claimed.id,{...c,status:'accepted',writtenAt:Date.now(),nativeMessageId:'retained'});
  f.store.deleteSessionRecord('B');
  assert.equal(f.peer.get(one.message.id).delivery.acceptedNativeMessageId,'retained');
  const offline=f.send('A','B','offline');assert.equal(offline.delivery.state,'queued');
  assert.throws(()=>f.peer.claimDelivery(offline.delivery.id,f.B.run),code('run_unavailable'));
  const reopened=createWorkspaceStore({dataDir:f.dir});
  try{assert.equal(reopened.peerMessages.inbox(f.B.id).items.length,2);assert.equal(reopened.peerMessages.outbox(f.A.id).items.length,2);}finally{reopened.close();}
});

test('mailbox pagination, bounded preview and byte limits retain separate messages and isolate cursors',t=>{
  const f=fixture(t),text='中'.repeat(2000);
  for(let i=0;i<4;i++)f.send('A','B','page-'+i,text);
  const first=f.peer.inbox(f.B.id,{limit:2}),next=f.peer.inbox(f.B.id,{limit:2,cursor:first.nextCursor!});
  assert.equal(new Set([...first.items,...next.items].map(x=>x.message.id)).size,4);
  assert.ok(first.items.every(x=>x.message.preview.length<=512&&x.message.truncated));
  assert.equal(f.peer.get(first.items[0]!.message.id).message.text,text);
  assert.throws(()=>f.peer.inbox(f.C.id,{cursor:first.nextCursor!}),code('invalid_request'));
  assert.throws(()=>f.peer.outbox(f.B.id,{cursor:first.nextCursor!}),code('invalid_request'));
  assert.throws(()=>f.send('A','B','large','中'.repeat(6000)),code('too_large'));
  assert.throws(()=>f.send('A','B','escape','\u001b[31m'),code('invalid_request'));
});

test('send transaction rolls back envelope and delivery together and old writers cannot edit them',t=>{
  const f=fixture(t),db=new DatabaseSync(join(f.dir,'workspace.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_peer_delivery BEFORE INSERT ON peer_deliveries BEGIN SELECT RAISE(ABORT,'delivery fault'); END");
    assert.throws(()=>f.send('A','B'),/delivery fault/);
    assert.equal(f.peer.inbox(f.B.id).items.length,0);assert.equal(f.peer.outbox(f.A.id).items.length,0);
    db.exec('DROP TRIGGER fail_peer_delivery');const saved=f.send('A','B');
    assert.throws(()=>db.prepare('DELETE FROM peer_messages WHERE id=?').run(saved.message.id));
    assert.throws(()=>db.exec("UPDATE peer_deliveries SET state='accepted'"));
    assert.equal(f.peer.get(saved.message.id).delivery.state,'queued');
  }finally{db.close();}
});
