import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fakeOwner,stdio,entry,pins,input,until,delay} from './fixtures.mjs';

const tool=(name,args={})=>({name,arguments:args});
const payload=reply=>reply.result.structuredContent??JSON.parse(reply.result.content[0].text);

test('real JSONL stdio initialize/list/call exposes only scoped peer tools and clean protocol stdout',async t=>{
  const f=await fakeOwner(t,({request,reply})=>reply(request.method==='peerContext'?{conversationId:'conversation-A',runId:'run-A'}:{message:{id:'m'},delivery:{state:'queued'}}));
  const io=await stdio(t,f.env),hello=await io.initialize();assert.ok(hello.result.capabilities.tools);
  const listed=await io.request(2,'tools/list');assert.deepEqual(listed.result.tools.map(x=>x.name).sort(),['agent_context','agent_inbox','agent_outbox','agent_peers','agent_send']);
  for(const definition of listed.result.tools){assert.equal(definition.inputSchema.additionalProperties,false);const schema=JSON.stringify(definition.inputSchema);assert.ok(!/ROOST_AGENT_|token|socketPath|terminalId/.test(schema));}
  const context=await io.request(3,'tools/call',tool('agent_context'));assert.deepEqual(payload(context),{conversationId:'conversation-A',runId:'run-A'});
  const sent=await io.request(4,'tools/call',tool('agent_send',input));assert.equal(payload(sent).delivery.state,'queued');assert.equal(payload(sent).message.id,'m');
  assert.equal(f.requests.length,2);assert.ok(io.frames.every(frame=>frame.jsonrpc==='2.0'));
});

test('MCP schemas reject credential injection, missing pins, unknown tool and UTF-8 overflow without forwarding',async t=>{
  const f=await fakeOwner(t,({reply})=>reply({ok:true})),io=await stdio(t,f.env);await io.initialize();
  const cases=[tool('agent_context',{token:'injected'}),tool('agent_send',{...input,expectedRunId:undefined}),tool('agent_send',{...input,senderConversationId:'forged'}),tool('agent_send',{...input,text:'中'.repeat(5120)+'x'}),tool('agent_inbox',{...pins,limit:101}),tool('unknown',{})];
  for(let i=0;i<cases.length;i++){const response=await io.request(i+10,'tools/call',cases[i]);assert.ok(response.error||response.result?.isError,'invalid tool input must fail');}
  assert.equal(f.requests.length,0);
});

test('raw stdio fragmented unicode calls and notifications correlate ids without unsolicited output',async t=>{
  const f=await fakeOwner(t,({request,reply})=>reply({echo:request.args[0].input?.text??'context'})),io=await stdio(t,f.env);await io.initialize();
  const raw=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:'unicode-id',method:'tools/call',params:tool('agent_send',input)})+'\n');
  // Split actual bytes inside UTF-8; writes must not decode separately in server.
  for(let index=0;index<raw.length;index+=7)io.child.stdin.write(raw.subarray(index,index+7));
  const reply=await until(()=>io.frames.find(x=>x.id==='unicode-id'));assert.equal(payload(reply).echo,input.text);
  io.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'unknown',reason:'test only'}});
  const ping=await io.request('ping','ping');assert.deepEqual(ping.result,{});assert.ok(!io.frames.some(x=>x.id===undefined&&x.result));
});

test('official v1 SDK client discovers and calls real stdio server with structured error fidelity',async t=>{
  const f=await fakeOwner(t,({socket,request,reply})=>{if(request.method==='peerInbox')socket.write(JSON.stringify({type:'reply',requestId:request.requestId,error:'sender_changed',code:'sender_changed',status:409})+'\n');else reply({conversationId:'conversation-A',runId:'run-A'});});
  const transport=new StdioClientTransport({command:process.execPath,args:[entry],env:{...f.env},stderr:'pipe'}),client=new Client({name:'isolated-sdk-qa',version:'1'});let stderr='';transport.stderr.on('data',x=>stderr+=x);
  t.after(async()=>{await client.close();assert.ok(!stderr.includes(f.env.ROOST_AGENT_TOKEN));});await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,5);
  const context=await client.callTool(tool('agent_context'));assert.equal(context.structuredContent.conversationId,'conversation-A');
  const stale=await client.callTool(tool('agent_inbox',pins));assert.equal(stale.isError,true);assert.equal(stale.structuredContent.error.code,'sender_changed');assert.equal(stale.structuredContent.error.status,409);
});

test('MCP cancellation releases in-flight IPC and leaves committed send retryable by same business key',async t=>{
  const saved={message:{id:'durable-one'},delivery:{state:'queued'}};let count=0;
  const f=await fakeOwner(t,({reply})=>{count++;if(count>1)reply(saved);}),io=await stdio(t,f.env);await io.initialize();
  io.send({jsonrpc:'2.0',id:'cancel-me',method:'tools/call',params:tool('agent_send',input)});await until(()=>f.requests.length===1);
  io.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'cancel-me',reason:'stop waiting'}});
  await until(()=>f.sockets.size===0);await delay(25);assert.equal(f.requests.length,1,'cancellation cannot auto-retry or invoke delivery cancellation');
  const retried=await io.request('new-rpc-id','tools/call',tool('agent_send',input));assert.equal(payload(retried).message.id,'durable-one');assert.equal(f.requests.length,2);assert.equal(f.requests[0].args[0].input.requestId,f.requests[1].args[0].input.requestId);
  const ping=await io.request('after-cancel','ping');assert.deepEqual(ping.result,{});
});

test('MCP bounds concurrent calls and rejects oversized stdin before daemon mutation',async t=>{
  const f=await fakeOwner(t,()=>{}),io=await stdio(t,f.env);await io.initialize();
  for(let id=10;id<19;id++)io.send({jsonrpc:'2.0',id,method:'tools/call',params:tool('agent_context')});
  const overflow=await until(()=>io.frames.find(x=>x.id>=10&&x.result?.isError));assert.ok(overflow.result.structuredContent.error.code);await until(()=>f.requests.length===8);assert.equal(f.requests.length,8);
  for(let id=10;id<19;id++)io.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}});
  await until(()=>f.sockets.size===0);
  const before=f.requests.length;io.write('x'.repeat(64*1024+1));await until(()=>io.child.exitCode!==null||io.child.signalCode!==null,2000);assert.equal(f.requests.length,before);
});

test('tool calls before initialized cannot create owner work; initialized notification enables calls',async t=>{
  const f=await fakeOwner(t,({reply})=>reply({ok:true})),io=await stdio(t,f.env);
  const before=await io.request('before','tools/call',tool('agent_send',input));assert.equal(before.result.isError,true);assert.equal(payload(before).error.code,'not_initialized');assert.equal(f.requests.length,0);
  await io.initialize();const after=await io.request('after','tools/call',tool('agent_context'));assert.equal(payload(after).ok,true);assert.equal(f.requests.length,1);
});

test('more than 16 cancelled tool calls release both RPC slots and owner sockets',async t=>{
  let respond=false;const f=await fakeOwner(t,({reply})=>{if(respond)reply({ok:true});}),io=await stdio(t,f.env);await io.initialize();
  for(let i=0;i<20;i++){
    const id='cancel-cycle-'+i;io.send({jsonrpc:'2.0',id,method:'tools/call',params:tool('agent_context')});await until(()=>f.requests.length===i+1);
    io.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}});await until(()=>f.sockets.size===0);
  }
  respond=true;const ping=await io.request('still-live','ping');assert.deepEqual(ping.result,{});const result=await io.request('after-20','tools/call',tool('agent_context'));assert.equal(payload(result).ok,true);assert.equal(f.requests.length,21);
});

for(const shutdown of ['EOF','SIGTERM'])test('stdio '+shutdown+' exits and cancels pending owner IPC without sending again',async t=>{
  const f=await fakeOwner(t,()=>{}),io=await stdio(t,f.env);await io.initialize();
  io.send({jsonrpc:'2.0',id:'pending',method:'tools/call',params:tool('agent_context')});await until(()=>f.requests.length===1);
  if(shutdown==='EOF')io.child.stdin.end();else io.child.kill('SIGTERM');
  await until(()=>io.child.exitCode!==null||io.child.signalCode!==null,2000);await until(()=>f.sockets.size===0);assert.equal(f.requests.length,1);
});

test('duplicate pending RPC id shuts down owner IPC and stdio child within bounded time',async t=>{
  const f=await fakeOwner(t,()=>{}),io=await stdio(t,f.env);await io.initialize();
  const request={jsonrpc:'2.0',id:'duplicate',method:'tools/call',params:tool('agent_context')};io.send(request);await until(()=>f.requests.length===1);io.send(request);
  await until(()=>io.child.exitCode!==null||io.child.signalCode!==null,2000);await until(()=>f.sockets.size===0);assert.equal(f.requests.length,1,'duplicate protocol request never starts a second owner operation');
});

test('more than 16 simultaneous unanswered protocol requests close instead of growing indefinitely',async t=>{
  const f=await fakeOwner(t,()=>{}),io=await stdio(t,f.env);await io.initialize();
  io.write(Array.from({length:17},(_,i)=>JSON.stringify({jsonrpc:'2.0',id:'burst-'+i,method:'tools/call',params:tool('agent_context')})).join('\n')+'\n');
  await until(()=>io.child.exitCode!==null||io.child.signalCode!==null,2000);await until(()=>f.sockets.size===0);assert.ok(f.requests.length<=8);
});

/*
  `agent_peers` 是发送链的第一环：没有它，模型拿不到任何 recipientId，只能等人先来信。
  所以这里盯两件事——它是只读的（不能被当成有副作用的动作而被模型回避或重试），
  以及它和 inbox/outbox 一样必须带钉子，缺钉子时**不转发给守护进程**。
*/
test('agent_peers is read-only, pinned, and never reaches the owner without both identity IDs',async t=>{
  const listed=[{recipientId:'conversation-B',title:'roost',cwd:'/w',cli:'claude',deliverable:true,reason:null},
    {recipientId:'conversation-C',title:'notes',cwd:'/n',cli:'codex',deliverable:false,reason:'busy'}];
  const f=await fakeOwner(t,({request,reply})=>reply(request.method==='peerPeers'?{conversationId:'conversation-A',runId:'run-A',peers:listed}:{}));
  const io=await stdio(t,f.env);await io.initialize();

  const tools=(await io.request(2,'tools/list')).result.tools;
  const definition=tools.find(x=>x.name==='agent_peers');
  assert.equal(definition.annotations.readOnlyHint,true,'列出同伴不该被标成有副作用');
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(),['expectedConversationId','expectedRunId']);

  const ok=await io.request(3,'tools/call',tool('agent_peers',pins));
  assert.deepEqual(payload(ok).peers,listed);
  assert.equal(f.requests.at(-1).method,'peerPeers');
  assert.equal(f.requests.length,1);

  // 缺钉子、多带字段：都必须在本地就被拒，不产生一次 IPC。
  for(const args of [{},{expectedConversationId:'conversation-A'},{...pins,cursor:'c'},{...pins,limit:5}]) {
    const bad=await io.request(10+f.requests.length,'tools/call',tool('agent_peers',args));
    assert.equal(bad.result.isError,true);assert.equal(payload(bad).error.code,'invalid_request');
  }
  assert.equal(f.requests.length,1,'被拒的调用一次都不该到守护进程');
});
