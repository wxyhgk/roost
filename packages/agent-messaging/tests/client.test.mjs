import test from 'node:test';
import assert from 'node:assert/strict';
import {requestPeer} from '../src/client.mjs';
import {fakeOwner,pins,input,until,delay} from './fixtures.mjs';

test('peer client routes context and explicit pins; owner credentials only come from env',async t=>{
  const f=await fakeOwner(t,({request,reply})=>reply(request.method==='peerContext'?{conversationId:'conversation-A',runId:'run-A'}:{ok:true}));
  assert.deepEqual(await requestPeer('context',{}, {env:f.env}),{conversationId:'conversation-A',runId:'run-A'});
  await requestPeer('send',input,{env:f.env});await requestPeer('inbox',pins,{env:f.env});await requestPeer('outbox',{...pins,limit:100},{env:f.env});
  assert.deepEqual(f.requests.map(x=>x.method),['peerContext','peerSend','peerInbox','peerOutbox']);
  assert.deepEqual(f.requests[1].args[0].input,input);assert.equal(f.requests[1].args[0].terminalId,'terminal-A');
  assert.ok(f.requests.every(x=>x.args[0].token===f.env.ROOST_AGENT_TOKEN));
});

test('peer client enforces UTF-8 payload and paging limits before socket mutation',async t=>{
  const f=await fakeOwner(t,({reply})=>reply({ok:true}));
  await requestPeer('send',{...input,text:'中'.repeat(5120)},{env:f.env});
  const before=f.requests.length;
  for(const invalid of [{...input,text:'中'.repeat(5120)+'x'},{...input,expectedRunId:''},{...input,expectedConversationId:'a'.repeat(512),expectedRunId:'b'.repeat(512),recipientId:'c'.repeat(512),requestId:'d'.repeat(512),text:'\n'.repeat(15359)+'x'}])await assert.rejects(requestPeer('send',invalid,{env:f.env}));
  for(const limit of [0,101,1.5])await assert.rejects(requestPeer('inbox',{...pins,limit},{env:f.env}));
  assert.equal(f.requests.length,before);
});

test('peer client retains owner code/status and never leaks token in errors',async t=>{
  const f=await fakeOwner(t,({socket,request})=>socket.write(JSON.stringify({type:'reply',requestId:request.requestId,error:'sender_changed',code:'sender_changed',status:409})+'\n'));
  await assert.rejects(requestPeer('send',input,{env:f.env}),error=>{assert.equal(error.code,'sender_changed');assert.equal(error.status,409);assert.ok(!String(error).includes(f.env.ROOST_AGENT_TOKEN));return true;});
});

test('peer client accepts split replies, ignores hello and unrelated request ids',async t=>{
  const f=await fakeOwner(t,({socket,request})=>{socket.write(JSON.stringify({type:'reply',requestId:'unrelated',result:{wrong:true}})+'\n');const line=JSON.stringify({type:'reply',requestId:request.requestId,result:{text:'世界🙂'}})+'\n';const bytes=Buffer.from(line);socket.write(bytes.subarray(0,bytes.length-5));setTimeout(()=>socket.write(bytes.subarray(bytes.length-5)),5);});
  assert.deepEqual(await requestPeer('context',{}, {env:f.env}),{text:'世界🙂'});
});

test('peer client abort before connect has no submission; abort after send releases socket without retry',async t=>{
  const f=await fakeOwner(t,()=>{}),pre=new AbortController();pre.abort();
  await assert.rejects(requestPeer('send',input,{env:f.env,signal:pre.signal}));assert.equal(f.requests.length,0);
  const post=new AbortController(),promise=requestPeer('send',input,{env:f.env,signal:post.signal});
  await until(()=>f.requests.length===1);post.abort();await assert.rejects(promise);await until(()=>f.sockets.size===0);await delay(30);assert.equal(f.requests.length,1);
});

test('peer client bounds timeout and invalid or oversized replies',async t=>{
  const quiet=await fakeOwner(t,()=>{});await assert.rejects(requestPeer('context',{}, {env:quiet.env,timeoutMs:25}));await until(()=>quiet.sockets.size===0);
  const malformed=await fakeOwner(t,({socket})=>socket.write('not json\n'));await assert.rejects(requestPeer('context',{}, {env:malformed.env}));
  const oversized=await fakeOwner(t,({socket})=>socket.write('x'.repeat(4*1024*1024+1)));await assert.rejects(requestPeer('context',{}, {env:oversized.env}));
});

test('peer client redacts credential strings in nested keys, values and daemon error details',async t=>{
  const token='a'.repeat(64),f=await fakeOwner(t,({request,socket,reply})=>{if(request.method==='peerContext')reply({[token]:[{deep:token}],safe:'ordinary'});else socket.write(JSON.stringify({type:'reply',requestId:request.requestId,error:{code:token,message:'failure '+token,status:403}})+'\n');});
  const value=await requestPeer('context',{}, {env:f.env});assert.ok(!JSON.stringify(value).includes(token));assert.deepEqual(value,{'[redacted]':[{deep:'[redacted]'}],safe:'ordinary'});
  await assert.rejects(requestPeer('inbox',pins,{env:f.env}),error=>{assert.ok(!String(error).includes(token)&&!error.code.includes(token));assert.equal(error.status,403);return true;});
});
