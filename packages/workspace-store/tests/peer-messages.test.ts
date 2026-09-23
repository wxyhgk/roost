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

/*
  认领之后卡在门口：状态留在 dispatching，但**原因要能传上去**。

  实测撞到的：一条消息在 CLI 忙的时候被认领，命令连续拿到 `busy` 二十多次，投递却从
  认领那一刻起 `reason` 恒为 NULL——界面只能说「正在提交，等待回执」，等谁、等什么，
  八分钟里一个字都没有。原因在 `finishFromCommand` 里：命令还在 queued 时直接 return，
  刚算出来的 `command.reason` 被丢掉。
*/
test('命令还在排队时，投递保持 dispatching 但带上原因',t=>{
  const f=fixture(t),{delivery}=f.send('A','B');
  const claimed=f.peer.claimDelivery(delivery.id,f.B.run,'hello');
  assert.equal(claimed.state,'dispatching');
  const c=f.command(claimed);
  assert.equal(f.peer.finishFromCommand(claimed.id,c).reason,null,'刚入队、还没有原因时不写');

  // CLI 忙：命令停在 queued，原因要能被读到。
  const busy=f.store.aiCommands.update(c.webSessionId,c.requestId,['queued'],{reason:'busy'})!;
  const waiting=f.peer.finishFromCommand(claimed.id,busy);
  assert.equal(waiting.state,'dispatching','状态不能退回 queued——退回去就重新开放了取消，会造成重复提交');
  assert.equal(waiting.reason,'busy','界面要说得出在等什么');

  // 原因没变就不许涨 revision：busy 会持续几分钟，每 250ms 涨一次会把乐观并发打光。
  const again=f.peer.finishFromCommand(claimed.id,busy);
  assert.equal(again.revision,waiting.revision,'原因没变时必须是 no-op');

  // 原因变了要跟上。
  const dialog=f.store.aiCommands.update(c.webSessionId,c.requestId,['queued'],{reason:'dialog'})!;
  const moved=f.peer.finishFromCommand(claimed.id,dialog);
  assert.equal(moved.reason,'dialog');
  assert.ok(moved.revision>waiting.revision,'原因变了要涨 revision，否则订阅方看不到');

  // 门开了：命令真的被接收，照常走到 accepted，原因清空。
  const accepted=f.store.aiCommands.update(c.webSessionId,c.requestId,['queued'],
    {status:'accepted',reason:null,nativeMessageId:'native-msg-1',writtenAt:Date.now()})!;
  const done=f.peer.finishFromCommand(claimed.id,accepted);
  assert.equal(done.state,'accepted');
  assert.equal(done.reason,null);
});

test('取消仍然只对 queued 开放——卡在门口的不能撤',t=>{
  const f=fixture(t),{delivery}=f.send('A','B');
  const claimed=f.peer.claimDelivery(delivery.id,f.B.run,'hello');
  f.command(claimed);
  const busy=f.store.aiCommands.update(claimed.commandSessionId!,claimed.commandRequestId,['queued'],{reason:'busy'})!;
  assert.equal(f.peer.finishFromCommand(claimed.id,busy).reason,'busy');
  assert.throws(()=>f.peer.cancel(claimed.id),code('already_dispatching'),'带上原因之后也绝不能变得可取消');
});

test('dismiss settles an unresolved message in both layers so the ones queued behind it can go',t=>{
  // 2026-09-22 的真实形状：贴进去了、没等到回显、再也等不到回执。它挡住了同一收件人后面的所有投递。
  const f=fixture(t),one=f.send('A','B','one','后续可以做什么'),claimed=f.peer.claimDelivery(one.delivery.id,f.B.run);
  const queuedCommand=f.command(claimed,'后续可以做什么');
  const stuck=f.store.aiCommands.update(queuedCommand.webSessionId,queuedCommand.requestId,['queued'],{status:'uncertain',reason:'awaiting_user_submit',writtenAt:Date.now()})!;
  assert.equal(f.peer.finishFromCommand(claimed.id,stuck).state,'uncertain');
  const two=f.send('A','B','two');
  assert.throws(()=>f.peer.claimDelivery(two.delivery.id,f.B.run),code('recipient_blocked'),'前提：不明的那条确实挡住了后面的');

  const dismissed=f.peer.dismiss(one.delivery.id);
  assert.equal(dismissed.state,'cancelled');
  assert.equal(dismissed.reason,'user_dismissed');
  const command=f.store.aiCommands.get(stuck.webSessionId,stuck.requestId)!;
  assert.equal(command.status,'cancelled','命令必须和投递一起落定，否则终端那边继续被它挡住');
  assert.equal(command.reason,'user_dismissed');
  assert.equal(command.revision,stuck.revision+1);
  assert.equal(f.store.aiCommands.active(stuck.webSessionId).length,0);
  assert.equal(f.peer.finishFromCommand(claimed.id,command).state,'cancelled','daemon 之后再同步也不能把它拉回 uncertain');

  assert.equal(f.peer.claimDelivery(two.delivery.id,f.B.run).state,'dispatching','后面那条放行了');
  assert.equal(f.peer.dismiss(one.delivery.id).revision,dismissed.revision,'重复放弃是幂等的');
});

test('only an unresolved message can be dismissed',t=>{
  const f=fixture(t),queued=f.send('A','B','queued');
  assert.throws(()=>f.peer.dismiss(queued.delivery.id),code('not_uncertain'),'排队中的走取消，不走放弃');
  const cancelled=f.send('A','B','cancelled');f.peer.cancel(cancelled.delivery.id);
  assert.throws(()=>f.peer.dismiss(cancelled.delivery.id),code('not_uncertain'),'用户取消的不能被改写成放弃');
  f.peer.cancel(queued.delivery.id);
  const sent=f.send('A','B','sent'),claimed=f.peer.claimDelivery(sent.delivery.id,f.B.run),c=f.command(claimed);
  f.peer.finishFromCommand(claimed.id,{...c,status:'accepted',writtenAt:Date.now(),nativeMessageId:'native-1'});
  assert.throws(()=>f.peer.dismiss(sent.delivery.id),code('not_uncertain'),'已经送达的绝不能被放弃');
});

/*
  终态要有出口。

  原来只有两个：`queued` 能取消、`uncertain` 能放弃。而 `cancelled` 和 `failed` 一个都没有
  ——它们不会自己消失，也没有任何按钮能让它们消失。实测撞到：一块面板上叠了 7 条
  「已取消/已放弃」，每条都带着「重试」，用户问的是**怎么删掉**。
*/
test('已经结束的可以从待发区拿走，没结束的不行',t=>{
  const f=fixture(t);
  const {delivery}=f.send('A','B','one');

  // 还在排队：不能移除。它还可能发出去，藏掉就是把唯一的处置入口拿走了。
  assert.throws(()=>f.peer.remove(delivery.id),code('not_finished'),'排队中的不许移除');

  f.peer.cancel(delivery.id);
  const removed=f.peer.remove(delivery.id);
  assert.equal(removed.reason,'user_removed');
  assert.equal(removed.state,'cancelled','**状态不变**——移除不是一次新的状态转移，只是不再摆在待发区');

  // 幂等：再按一次不该继续涨 revision（界面上可能连点）。
  const again=f.peer.remove(delivery.id);
  assert.equal(again.revision,removed.revision,'重复移除必须是 no-op');
});

test('移除 failed 的那条，状态仍然是 failed',t=>{
  /*
    **状态必须原样留着。** 只测 cancelled 分不出「不动状态」和「顺手写成 cancelled」这两种
    实现（变异测试发现）——而后者会把「它当初是失败的」这个事实抹掉，以后看记录时
    一条失败的消息会显示成用户取消的。
  */
  const f=fixture(t);
  const {delivery}=f.send('A','B','three');
  const claimed=f.peer.claimDelivery(delivery.id,f.B.run,'hello');
  const c=f.command(claimed);
  const failed=f.store.aiCommands.update(c.webSessionId,c.requestId,['queued'],
    {status:'failed',reason:'write_failed',writtenAt:null})!;
  assert.equal(f.peer.finishFromCommand(claimed.id,failed).state,'failed');

  const removed=f.peer.remove(claimed.id);
  assert.equal(removed.state,'failed','不能把失败改写成取消');
  assert.equal(removed.reason,'user_removed');
});

test('dispatching 和 uncertain 都不算结束，不许移除',t=>{
  const f=fixture(t);
  const {delivery}=f.send('A','B','two');
  const claimed=f.peer.claimDelivery(delivery.id,f.B.run,'hello');
  assert.throws(()=>f.peer.remove(claimed.id),code('not_finished'),'在途的不许移除');

  f.peer.markUncertain(claimed.id);
  assert.throws(()=>f.peer.remove(claimed.id),code('not_finished'),
    'uncertain 有它自己的出口（放弃），而且它悬着会挡住后面的——藏掉等于让人没法处理');
});
