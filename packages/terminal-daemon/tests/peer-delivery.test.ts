import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer as createNetServer} from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkspaceStore} from '@roost/workspace-store';
import {createAiSessionBridge} from '@roost/ai-session-bridge';
import type {AiCommandInput} from '@roost/terminal-protocol';
import {createPeerDeliveryOwner} from '../src/peer-delivery.ts';
import {createAiCommandOwner} from '../src/ai-command-owner.ts';
import {startTerminalOwner} from '../src/owner.ts';

function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'g2-peer-owner-')),store=createWorkspaceStore({dataDir:dir});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  const live=new Map<string,any>(),ids:Record<string,string>={};
  for(const name of ['A','B','C']) {
    store.upsertSession({id:name,cwd:dir});bridge.bind({webSessionId:name,terminalInstanceId:'instance-'+name,cliId:'omp',nativeSessionId:'native-'+name});
    live.set(name,{id:name,instanceId:'instance-'+name,cli:'omp',pid:123});
    ids[name]=store.conversations.list().items.find(x=>x.source.nativeSessionId==='native-'+name)!.id;
  }
  const controls=new Map<string,{supported:boolean;reason:string|null}>();
  const enqueues:{terminal:string;input:AiCommandInput}[]=[],native:{terminal:string;text:string}[]=[];
  let mode:'queued'|'accepted'|'no-command-throw'|'native-write-throw'|'accepted-response-lost'='queued';
  const commands={
    control(id:string){return {...(controls.get(id)??{supported:false,reason:'sending_disabled'}),inputEpoch:0,queue:store.aiCommands.active(id)};},
    enqueue(id:string,input:AiCommandInput){
      enqueues.push({terminal:id,input});
      if(mode==='no-command-throw')throw new Error('command request disappeared at boundary');
      let c=store.aiCommands.enqueue(id,input);
      if(mode==='queued')return c;
      native.push({terminal:id,text:input.text});
      c=store.aiCommands.update(id,input.requestId,['queued'],{status:'writing',writtenAt:Date.now()})!;
      if(mode==='native-write-throw')throw new Error('native accepted before receipt');
      c=store.aiCommands.update(id,input.requestId,['writing'],{status:'accepted',nativeMessageId:'receipt-'+native.length})!;
      if(mode==='accepted-response-lost')throw new Error('IPC response lost after durable accepted command');
      return c;
    },
  };
  const runtime={getSession:(id:string)=>live.get(id),writeSession(){assert.fail('peer delivery must never bypass the command owner writer');}} as any;
  const owners:ReturnType<typeof createPeerDeliveryOwner>[]=[];
  const owner=(ownerId='owner')=>{const value=createPeerDeliveryOwner({store,runtime,commands:commands as any,ownerId});owners.push(value);return value;};
  const send=(requestId='request')=>store.peerMessages.send({kind:'user'},{recipientId:ids.B!,requestId,text:'hello from GUI'});
  t.after(()=>{owners.forEach(x=>x.dispose());store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,store,bridge,live,ids,controls,enqueues,native,owner,send,setMode(value:typeof mode){mode=value;}};
}

test('constructing coordinator is inert and unsupported, busy or draft recipients are never submitted',t=>{
  const f=fixture(t),message=f.send(),owner=f.owner();
  owner.pump();assert.equal(f.store.conversationRuns.list().length,0);assert.equal(f.enqueues.length,0);
  owner.start();assert.equal(f.store.peerMessages.get(message.message.id).delivery.state,'queued');
  for(const reason of ['busy','terminal_draft','dialog']) {
    f.controls.set('B',{supported:true,reason});owner.pump();
    assert.equal(f.enqueues.length,0);assert.equal(f.store.peerMessages.get(message.message.id).delivery.reason,reason);
  }
  owner.dispose();f.controls.set('B',{supported:true,reason:null});owner.pump();assert.equal(f.enqueues.length,0);
});

test('coordinator uses one command request and trustworthy origin prefix, accepting a lost response by evidence',t=>{
  const f=fixture(t),message=f.send(),owner=f.owner();f.controls.set('B',{supported:true,reason:null});f.setMode('accepted-response-lost');
  owner.start();owner.pump();owner.pump();
  assert.equal(f.enqueues.length,1);assert.equal(f.native.length,1);assert.equal(f.enqueues[0]!.terminal,'B');
  const sent=f.enqueues[0]!.input;
  assert.equal(sent.nativeSessionId,'native-B');assert.equal(sent.terminalInstanceId,'instance-B');
  assert.ok(sent.text.includes(message.message.id));assert.ok(sent.text.includes('"senderKind":"user"'));assert.ok(sent.text.endsWith('hello from GUI'));
  const result=f.store.peerMessages.get(message.message.id).delivery;
  assert.equal(result.state,'accepted');assert.equal(result.commandRequestId,sent.requestId);
  assert.equal(f.store.peerMessages.inbox(f.ids.C!).items.length,0);
});

test('claim without a command becomes uncertain and blocks later mail across owner replacement',t=>{
  const f=fixture(t),one=f.send('one'),two=f.send('two'),owner=f.owner();
  f.controls.set('B',{supported:true,reason:null});f.setMode('no-command-throw');owner.start();
  assert.equal(f.store.peerMessages.get(one.message.id).delivery.state,'uncertain');
  assert.equal(f.store.peerMessages.get(two.message.id).delivery.state,'queued');
  assert.equal(f.enqueues.length,1);assert.equal(f.native.length,0);
  owner.dispose();f.setMode('accepted');const next=f.owner('replacement');next.start();next.pump();
  assert.equal(f.enqueues.length,1,'new owner must not retry an ambiguous submission boundary');
  assert.equal(f.store.peerMessages.get(two.message.id).delivery.state,'queued');
});

test('native write then lost receipt is never resent after recovery and late exact proof resolves uncertainty',t=>{
  const f=fixture(t),message=f.send(),owner=f.owner();
  f.controls.set('B',{supported:true,reason:null});f.setMode('native-write-throw');owner.start();
  assert.equal(f.native.length,1);
  owner.dispose();f.store.aiCommands.recoverOwner();
  const replacement=f.owner('replacement');replacement.start();replacement.pump();
  const pending=f.store.peerMessages.get(message.message.id).delivery;
  assert.equal(pending.state,'uncertain');assert.equal(f.enqueues.length,1);assert.equal(f.native.length,1);
  f.store.aiCommands.update('B',pending.commandRequestId,['uncertain'],{status:'accepted',nativeMessageId:'late-proof',reason:null});
  replacement.pump();assert.equal(f.store.peerMessages.get(message.message.id).delivery.state,'accepted');
  assert.equal(f.native.length,1);
});

test('sender identity is resolved from current terminal and stale instance cannot impersonate another conversation',t=>{
  const f=fixture(t),owner=f.owner();owner.start();
  const context=owner.contextFromTerminal('A','instance-A');
  const pins={expectedConversationId:context.conversationId,expectedRunId:context.runId};
  const sent=owner.sendFromTerminal('A','instance-A',{recipientId:f.ids.B!,requestId:'agent',text:'A to B',...pins});
  assert.equal(sent.message.senderConversationId,f.ids.A);assert.equal(sent.message.senderKind,'agent');
  assert.equal(owner.listFromTerminal('outbox','A','instance-A',pins).items[0]!.message.id,sent.message.id);
  assert.throws(()=>owner.sendFromTerminal('A','instance-C',{recipientId:f.ids.B!,requestId:'spoof',text:'wrong',...pins}),(e:any)=>e.code==='terminal_changed');
  f.live.delete('A');assert.throws(()=>owner.sendFromTerminal('A','instance-A',{recipientId:f.ids.B!,requestId:'gone',text:'wrong',...pins}),(e:any)=>e.code==='terminal_changed');
});

test('cached sender pins reject identical retries after native switch within the same terminal instance',t=>{
  const f=fixture(t),owner=f.owner();owner.start();
  const context=owner.contextFromTerminal('A','instance-A');
  const input={recipientId:f.ids.B!,requestId:'cached-from-A',text:'original sender',expectedConversationId:context.conversationId,expectedRunId:context.runId};
  const original=owner.sendFromTerminal('A','instance-A',input);
  assert.equal(owner.sendFromTerminal('A','instance-A',input).message.id,original.message.id);
  f.store.conversationRuns.endTerminal('A','same_conversation_restart');owner.pump();
  const resumed=owner.contextFromTerminal('A','instance-A');assert.equal(resumed.conversationId,context.conversationId);assert.notEqual(resumed.runId,context.runId);
  const refreshedInput={...input,expectedRunId:resumed.runId};
  assert.equal(owner.sendFromTerminal('A','instance-A',refreshedInput).message.id,original.message.id,'explicit fresh run context preserves logical request idempotency');
  const before=f.bridge.get('A')!;f.bridge.rebind({...before,nativeSessionId:'new-conversation-in-same-terminal'},before.generation,before.revision);owner.pump();
  const changed=owner.contextFromTerminal('A','instance-A');assert.notEqual(changed.conversationId,context.conversationId);
  assert.throws(()=>owner.sendFromTerminal('A','instance-A',refreshedInput),(e:any)=>e.code==='sender_changed');
  assert.throws(()=>owner.listFromTerminal('outbox','A','instance-A',{expectedConversationId:context.conversationId,expectedRunId:resumed.runId}),(e:any)=>e.code==='sender_changed');
  assert.throws(()=>owner.sendFromTerminal('A','instance-A',{recipientId:f.ids.B!,requestId:'unpinned',text:'unsafe'} as any),(e:any)=>e.code==='sender_pin_required');
  assert.equal(f.store.peerMessages.inbox(f.ids.B!).items.length,1,'stale helper retry must not produce a second sender/message');
});

test('rebound terminal never receives a queued message for its old conversation',t=>{
  const f=fixture(t),message=f.send(),owner=f.owner();owner.start();
  const old=f.bridge.get('B')!;f.bridge.rebind({...old,nativeSessionId:'different-native'},old.generation,old.revision);
  f.controls.set('B',{supported:true,reason:null});f.setMode('accepted');owner.pump();
  assert.equal(f.enqueues.length,0);assert.equal(f.native.length,0);
  assert.equal(f.store.peerMessages.get(message.message.id).delivery.state,'queued');
  assert.equal(f.store.conversationRuns.active(f.ids.B!),undefined);
});

test('actual command owner checks the source owner epoch again before writing a claimed peer input',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'g2-command-fence-')),path=join(dir,'native.jsonl');writeFileSync(path,'');
  const store=createWorkspaceStore({dataDir:dir});store.upsertSession({id:'s',cwd:dir});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  const binding=bridge.bind({webSessionId:'s',terminalInstanceId:'i',cliId:'claude',nativeSessionId:'n',transcriptPath:path});
  const run=store.conversationRuns.observe(binding,'daemon-1'),writes:string[]=[];
  const live={id:'s',instanceId:'i',cli:'claude',cwd:dir,pid:1};
  const owner=createAiCommandOwner({store,runtime:{getSession:()=>live,writeSession:(_id:string,data:string)=>writes.push(data)} as any,enabled:true,ownerId:'daemon-1',changed:()=>{},now:()=>1000});
  t.after(()=>{owner.dispose();store.close();rmSync(dir,{recursive:true,force:true});});
  owner.ensure(live);owner.hook('s',{event:'SessionStart',sessionId:'n',version:'2.1.266'},1);
  owner.output('s',{type:'output',instanceId:'i',seq:1,data:'\x1b[2J\x1b[HClaude Code v2.1.266\r\n────────────────────────────────────────\r\n❯ \r\n────────────────────────────────────────\r\nshift+tab to cycle\x1b[3;3H'});
  await new Promise(r=>setTimeout(r,20));
  const {delivery}=store.peerMessages.send({kind:'user'},{recipientId:run.conversationId,requestId:'fence',text:'must not write'});
  store.peerMessages.claimDelivery(delivery.id,run,'must not write');
  owner.enqueue('s',{requestId:delivery.commandRequestId,type:'submit',terminalInstanceId:'i',generation:binding.generation,nativeSessionId:'n',text:'must not write'});
  store.conversationRuns.retireOtherOwners('daemon-2');const replacement=store.conversationRuns.observe(binding,'daemon-2');
  assert.ok(replacement.ownerEpoch>run.ownerEpoch);await owner.pump('s');
  assert.deepEqual(writes,[]);assert.notEqual(store.aiCommands.get('s',delivery.commandRequestId)?.status,'accepted');
});

test('SIGKILL after a separately flushed fake-native write preserves uncertainty without retry on replacement',async t=>{
  const f=fixture(t),message=f.send('crash'),script=join(f.dir,'child.mjs'),ledger=join(f.dir,'native-ledger.jsonl');
  const storeUrl=new URL('../../workspace-store/src/index.ts',import.meta.url).href;
  const ownerUrl=new URL('../src/peer-delivery.ts',import.meta.url).href;
  // This child has no PTY or model. Its fsynced ledger is an independent oracle
  // for an irreversible external accept before the application's receipt commit.
  writeFileSync(script,`
    import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
    import {createWorkspaceStore} from ${JSON.stringify(storeUrl)};
    import {createPeerDeliveryOwner} from ${JSON.stringify(ownerUrl)};
    const store=createWorkspaceStore({dataDir:${JSON.stringify(f.dir)}});
    const runtime={getSession:id=>({id,instanceId:'instance-'+id,cli:'omp',pid:123})};
    const commands={control:id=>({supported:id==='B',reason:id==='B'?null:'disabled',queue:store.aiCommands.active(id),inputEpoch:0}),enqueue(id,input){
      store.aiCommands.enqueue(id,input);
      const command=store.aiCommands.update(id,input.requestId,['queued'],{status:'writing',writtenAt:Date.now()});
      const fd=openSync(${JSON.stringify(ledger)},'a');writeSync(fd,JSON.stringify({id,requestId:input.requestId,text:input.text})+'\\n');fsyncSync(fd);closeSync(fd);
      process.send({type:'native-written',requestId:input.requestId});return command;
    }};
    setInterval(()=>{},1000);
    createPeerDeliveryOwner({store,runtime,commands,ownerId:'child-owner'}).start();
  `);
  const child=spawn(process.execPath,['--import','tsx',script],{cwd:process.cwd(),stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr?.on('data',data=>{stderr+=data.toString();});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const exited=once(child,'exit');
    await Promise.race([
      once(child,'message').then(([event])=>assert.equal((event as any).type,'native-written')),
      exited.then(([exitCode])=>{throw new Error('child exited before boundary: '+exitCode+' '+stderr);}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('child boundary timeout: '+stderr)),5000);}),
    ]);
    clearTimeout(timer);child.kill('SIGKILL');await exited;
    assert.equal(readFileSync(ledger,'utf8').trim().split('\n').length,1);
    f.store.aiCommands.recoverOwner();f.controls.set('B',{supported:true,reason:null});f.setMode('accepted');
    const replacement=f.owner('after-crash');replacement.start();replacement.pump();replacement.pump();
    assert.equal(f.store.peerMessages.get(message.message.id).delivery.state,'uncertain');
    assert.equal(f.enqueues.length,0);assert.equal(readFileSync(ledger,'utf8').trim().split('\n').length,1);
  } finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.kill('SIGKILL');await closed;}}
});

test('failed socket acquisition does not recover another owner commands; successful acquisition does',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'g2-socket-fence-')),socketPath=join(dir,'owner.sock'),store=createWorkspaceStore({dataDir:dir}),guard=createNetServer();
  store.upsertSession({id:'s',cwd:dir});store.aiCommands.enqueue('s',{requestId:'saved',type:'submit',terminalInstanceId:'i',generation:'g',nativeSessionId:'n',text:'retained queued'});
  await new Promise<void>(r=>guard.listen(socketPath,r));
  let owner:Awaited<ReturnType<typeof startTerminalOwner>>|undefined;
  try {
    await assert.rejects(startTerminalOwner({socketPath,dataDir:dir,shell:'/bin/sh',defaultCwd:dir}),{code:'EADDRINUSE'});
    assert.equal(store.aiCommands.get('s','saved')?.status,'queued');
    await new Promise<void>(r=>guard.close(()=>r()));
    owner=await startTerminalOwner({socketPath,dataDir:dir,shell:'/bin/sh',defaultCwd:dir});
    assert.equal(store.aiCommands.get('s','saved')?.status,'cancelled');
    assert.equal(store.aiCommands.get('s','saved')?.text,'retained queued');
  }finally{await owner?.stop();if(guard.listening)await new Promise<void>(r=>guard.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});

/*
  run 结束之后，排队里的消息不能被忘掉。

  投递循环的外层是 activeRuns，所以一条对话的 run 一旦结束，它排队里的消息就再也不会
  被访问到——连那句把原因改成 recipient_offline 的代码都在循环里面，跟着一起够不着。
  于是它永远停在入队时钉的 'pending'，而界面把 pending 显示成「已排队，等待写入」。
  对一条永远等不到的消息，那句话是假的。
*/
test('没有在跑的 run 时，排队消息被标成 offline 而不是永远停在 pending',t=>{
  const f=fixture(t),message=f.send();
  assert.equal(f.store.peerMessages.get(message.message.id).delivery.reason,'pending','入队时钉的初始值');
  // 收件那个终端没了：run 建不起来，于是这条消息落在主循环的可达范围之外。
  f.live.delete('B');
  const owner=f.owner();owner.start();owner.pump();
  // A 和 C 仍然活着——正是真实情形：别的对话有 run，唯独这一条没有。
  assert.equal(f.store.conversationRuns.active(f.ids.B!),undefined,'前提：B 这条对话确实没有在跑的 run');
  assert.ok(f.store.conversationRuns.listActive('owner').length>0,'别的对话还在跑，扫描要能分辨');
  const delivery=f.store.peerMessages.get(message.message.id).delivery;
  assert.equal(delivery.state,'queued','消息不丢，只是投不出去');
  assert.equal(delivery.reason,'recipient_offline');
});

test('终端回来之后照常投递，孤儿标记不会挡住恢复',t=>{
  const f=fixture(t),message=f.send();
  f.live.delete('B');
  const owner=f.owner();owner.start();owner.pump();
  assert.equal(f.store.peerMessages.get(message.message.id).delivery.reason,'recipient_offline');
  // 终端回来：主循环重新看得到它，按当时的实际情况改写原因并投递。
  f.live.set('B',{id:'B',instanceId:'instance-B',cli:'omp',pid:123});
  f.controls.set('B',{supported:true,reason:null});f.setMode('accepted');
  owner.pump();owner.pump();
  assert.equal(f.enqueues.length,1);
  assert.equal(f.store.peerMessages.get(message.message.id).delivery.state,'accepted');
});

test('有在跑的 run 时不乱标：该说什么原因还说什么原因',t=>{
  const f=fixture(t),message=f.send(),owner=f.owner();
  f.controls.set('B',{supported:true,reason:'busy'});
  owner.start();owner.pump();
  // busy 是主循环给的说法；孤儿扫描不能把它盖成 offline。
  assert.equal(f.store.peerMessages.get(message.message.id).delivery.reason,'busy');
});

/*
  收件箱里卡着一条没定论的消息时，后面那些要**说得出为什么**。

  `claimDelivery` 在收件人有更早的、或者未解决的投递时抛 409 recipient_blocked。原来这个
  异常被外层的 `catch {}` 吞掉，投递原地不动、保留着上一轮写下的旧原因——而
  `setQueuedReason` 只在原因变化时才写库，于是界面上那句话可能是几分钟前的。

  实测撞到：收件箱里有一条 uncertain 的旧消息（用户点了取消，但它已经写进过终端，所以
  只能是「不确定」），后面四条被永久挡住，而界面一直说「CLI 正在处理上一轮，排队等待」。
  那 24 秒里闸其实是全开的（reason=null、队列空），pump 跑了约 96 次，一次都没成，
  也一个字都没说。

  recipient_blocked 尤其不能沉默：它**不会自己好**，得有人去处理前面那条。
*/
test('前面有一条没定论时，后面的投递要记下 recipient_blocked',t=>{
  const f=fixture(t),owner=f.owner();
  owner.start();
  f.controls.set('B',{supported:true,reason:null});

  /*
    第一条走到 dispatching，然后把它变成实测里那个形状：**命令已经收场（不在活动队列里），
    投递却停在 uncertain**——用户点了取消，但正文写进过终端，所以只能是「不确定」。
    这一步很要紧：命令还在队列里时 pump 会先被 command_pending 短路，根本走不到认领。
  */
  const first=f.send('first');owner.pump();
  assert.equal(f.store.peerMessages.get(first.message.id).delivery.state,'dispatching');
  const command=f.enqueues[0]!;
  f.store.aiCommands.update(command.terminal,command.input.requestId,['queued'],
    {status:'cancelled',reason:'user_cancelled',writtenAt:Date.now()});
  f.store.peerMessages.finishFromCommand(f.store.peerMessages.get(first.message.id).delivery.id,
    f.store.aiCommands.get(command.terminal,command.input.requestId)!);
  assert.equal(f.store.peerMessages.get(first.message.id).delivery.state,'uncertain','写过就只能是不确定');
  assert.equal(f.store.aiCommands.active(command.terminal).length,0,'命令已收场，闸是全开的');

  // 第二条必然被挡：收件人还有一条没定论。
  const second=f.send('second');owner.pump();
  const blocked=f.store.peerMessages.get(second.message.id).delivery;
  assert.equal(blocked.state,'queued','挡住了，但不该消失');
  assert.equal(blocked.reason,'recipient_blocked','必须说出为什么，而不是留着上一轮的旧原因');
  assert.equal(f.enqueues.length,1,'只有第一条真的写出去了');

  // 原因没变就不该反复涨 revision：pump 每 250ms 跑一次。
  const revision=f.store.peerMessages.get(second.message.id).delivery.revision;
  owner.pump();owner.pump();
  assert.equal(f.store.peerMessages.get(second.message.id).delivery.revision,revision,'原因没变时是 no-op');
});

test('认领失败时冒出没见过的错误码，不许原样显示给用户',t=>{
  /*
    名单是**白名单**，不是照单全收：这些字符串会原样走到界面上，所以只放出已经写过说法的
    那几种。冒出一个没见过的码时宁可什么都不说——留着上一轮的原因难看，但比在界面上
    甩一个内部标识符强，那正是这一轮修的那个毛病。
  */
  const f=fixture(t);
  let thrown=0;
  const store={...f.store,peerMessages:{...f.store.peerMessages,
    claimDelivery(){thrown++;throw Object.assign(new Error('boom'),{code:'a_code_nobody_wrote_a_sentence_for'});}}};
  const owner=createPeerDeliveryOwner({store:store as any,runtime:{getSession:(id:string)=>f.live.get(id)} as any,
    commands:{control:()=>({supported:true,reason:null,inputEpoch:0,queue:[]}),enqueue:()=>assert.fail('认领都没成，不该去写命令')} as any,
    ownerId:'owner'});
  t.after(()=>owner.dispose());
  owner.start();
  const message=f.send('unknown-code');
  owner.pump();
  assert.ok(thrown>0,'这一轮确实走到了认领');
  const delivery=f.store.peerMessages.get(message.message.id).delivery;
  assert.equal(delivery.state,'queued');
  assert.notEqual(delivery.reason,'a_code_nobody_wrote_a_sentence_for','名单外的码不许落到投递上');
});

/*
  `peersFromTerminal` 补的是 agent 之间的「谁在那儿」。它唯一可能造成的伤害是**说谎**——
  列一个送不到的收件人，让模型发出去、状态停在 queued、而它以为发到了。所以下面这两条
  测试盯的都是「列表与 pump 的判断一致」，以及「列出来的 recipientId 真的能用」。
*/
test('peer list mirrors the pump gate exactly and never lists the caller itself',t=>{
  const f=fixture(t),owner=f.owner();owner.start();
  const context=owner.contextFromTerminal('A','instance-A');
  const pins={expectedConversationId:context.conversationId,expectedRunId:context.runId};

  // 默认 control 是 supported:false + reason 'sending_disabled'：列出来，但不可达，且说得出原因。
  const initial=owner.peersFromTerminal('A','instance-A',pins);
  assert.deepEqual(initial.peers.map(p=>p.recipientId).sort(),[f.ids.B!,f.ids.C!].sort(),'自己不在列表里');
  assert.ok(initial.peers.every(p=>!p.deliverable&&p.reason==='sending_disabled'));

  // supported:false 而 reason 为 null 时得有个说法，不能是 null——否则 deliverable=false 无从解释。
  f.controls.set('B',{supported:false,reason:null});
  assert.equal(owner.peersFromTerminal('A','instance-A',pins).peers.find(p=>p.recipientId===f.ids.B)!.reason,'unsupported_cli');

  // 闸全开才算可达。
  f.controls.set('B',{supported:true,reason:null});
  const openB=owner.peersFromTerminal('A','instance-A',pins).peers.find(p=>p.recipientId===f.ids.B)!;
  assert.equal(openB.deliverable,true);assert.equal(openB.reason,null);
  assert.equal(openB.cli,'omp');assert.equal(openB.cwd,f.dir);

  // pump 遇到 reason 会写进 setQueuedReason，列表必须说同一句话。
  f.controls.set('C',{supported:true,reason:'busy'});
  const busyC=owner.peersFromTerminal('A','instance-A',pins).peers.find(p=>p.recipientId===f.ids.C)!;
  assert.equal(busyC.deliverable,false);assert.equal(busyC.reason,'busy');

  // 队列非空也进不去——这一条 pump 里是单独判断的，容易在别处漏掉。
  f.store.aiCommands.enqueue('B',{requestId:'occupying',type:'submit',terminalInstanceId:'instance-B',generation:f.bridge.get('B')!.generation,nativeSessionId:'native-B',text:'someone else first'});
  const pendingB=owner.peersFromTerminal('A','instance-A',pins).peers.find(p=>p.recipientId===f.ids.B)!;
  assert.equal(pendingB.deliverable,false);assert.equal(pendingB.reason,'command_pending');
});

test('a recipientId taken from the peer list is accepted by send, and the list is pinned like the mailboxes',t=>{
  const f=fixture(t),owner=f.owner();owner.start();
  const context=owner.contextFromTerminal('A','instance-A');
  const pins={expectedConversationId:context.conversationId,expectedRunId:context.runId};
  f.controls.set('B',{supported:true,reason:null});

  // 列表→发送 这条链必须真的走得通，否则这个工具只是装饰。
  const target=owner.peersFromTerminal('A','instance-A',pins).peers.find(p=>p.deliverable)!;
  assert.equal(target.recipientId,f.ids.B);
  const sent=owner.sendFromTerminal('A','instance-A',{recipientId:target.recipientId,requestId:'from-list',text:'found you',...pins});
  assert.equal(f.store.peerMessages.inbox(f.ids.B!).items[0]!.message.id,sent.message.id);

  // 钉子和 inbox/outbox 一视同仁：这份列表是 send 的输入，身份不对就该在这儿响。
  assert.throws(()=>owner.peersFromTerminal('A','instance-A',{} as any),(e:any)=>e.code==='sender_pin_required');
  assert.throws(()=>owner.peersFromTerminal('A','instance-A',{expectedConversationId:context.conversationId,expectedRunId:'not-this-run'}),(e:any)=>e.code==='sender_changed');
  assert.throws(()=>owner.peersFromTerminal('A','instance-C',pins),(e:any)=>e.code==='terminal_changed');
});

test('peers owned by another daemon are left out: the pump can only ever answer them with recipient_offline',t=>{
  const f=fixture(t),owner=f.owner();owner.start();
  const context=owner.contextFromTerminal('A','instance-A');
  const pins={expectedConversationId:context.conversationId,expectedRunId:context.runId};
  f.controls.set('B',{supported:true,reason:null});f.controls.set('C',{supported:true,reason:null});
  assert.equal(owner.peersFromTerminal('A','instance-A',pins).peers.length,2);

  /*
    把 C 交给另一个守护进程，并且让本进程看不见它的 PTY——`syncRuns` 只认领本进程里活着的
    终端，所以它不会被抢回来。这正是 `pump()` 里 `run.daemonInstanceId !== ownerId` 那一支
    对应的现实：消息发过去只会停在 `recipient_offline`。列表必须跟 pump 用同一个口径。
  */
  f.store.conversationRuns.endTerminal('C','terminal_exited');
  f.store.conversationRuns.observe(f.bridge.get('C')!,'another-daemon');
  f.live.delete('C');
  const scoped=owner.peersFromTerminal('A','instance-A',pins);
  assert.deepEqual(scoped.peers.map(p=>p.recipientId),[f.ids.B!],'别的守护进程拥有的对话不该出现在列表里');
  assert.ok(f.store.conversationRuns.listActive().some(r=>r.conversationId===f.ids.C),'前提：那条 run 确实还活着，只是不归本进程');
});
