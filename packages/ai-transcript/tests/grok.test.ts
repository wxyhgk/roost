import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverGrokTranscript,readGrokTranscript} from '../src/grok.ts';
const notification = (id:string,sessionUpdate:string,body = {},sessionId='native-1') => JSON.stringify({timestamp:1788935704,method:'session/update',params:{sessionId,update:{sessionUpdate,...body},_meta:{eventId:id,agentTimestampMs:1788935703703}}})+'\n';
async function fixture(t:any) { const dir=await mkdtemp(join(tmpdir(),'grok-reader-'));t.after(()=>rm(dir,{recursive:true,force:true}));const folder=join(dir,'encoded-project','native-1');await mkdir(folder,{recursive:true});return {dir,path:join(folder,'updates.jsonl')}; }
test('Grok native updates preserve IDs, chunks, tool results and incremental UTF-8',async t=>{
 const {path}=await fixture(t);
 await writeFile(path,notification('native-1-2','user_message_chunk',{content:{type:'text',text:'hello'}}));
 let r=await readGrokTranscript(path,'native-1');assert.equal(r.items[0].eventId,'grok:native-1:native-1-2');assert.equal(r.items[0].role,'user');
 const line=Buffer.from(notification('native-1-3','agent_message_chunk',{content:{type:'text',text:'你好'}}));const at=line.indexOf(Buffer.from('你'))+1;
 await appendFile(path,line.subarray(0,at));r=await readGrokTranscript(path,'native-1',r.checkpoint);assert.equal(r.items.length,0);
 await appendFile(path,line.subarray(at));r=await readGrokTranscript(path,'native-1',r.checkpoint);assert.equal(r.items[0].content,'你好');
 await appendFile(path,notification('native-1-4','tool_call_update',{toolCallId:'t1',status:'completed',content:[{type:'content',content:{type:'text',text:'ok'}}]}));r=await readGrokTranscript(path,'native-1',r.checkpoint);assert.equal(r.items[0].data.parts[1].type,'tool_result');assert.equal(r.items[0].data.parts[1].text,'ok');assert.equal((await readGrokTranscript(path,'native-1',r.checkpoint)).items.length,0);
});
test('Grok rejects mixed session, unverified header, exact discovery ambiguity',async t=>{
 const {dir,path}=await fixture(t);await writeFile(path,notification('a','user_message_chunk',{content:{type:'text',text:'x'}}));
 assert.equal(await discoverGrokTranscript('native-1',[dir]),await realpath(path));await assert.rejects(readGrokTranscript(path,'other'),/session_mismatch/);
 await appendFile(path,notification('b','agent_message_chunk',{content:{type:'text',text:'wrong'}},'other'));await assert.rejects(readGrokTranscript(path,'native-1'),/session_mismatch/);
 await writeFile(path,notification('a','user_message_chunk',{content:{type:'text',text:'x'}}));const second=join(dir,'second','native-1');await mkdir(second,{recursive:true});await writeFile(join(second,'updates.jsonl'),notification('a','user_message_chunk',{content:{type:'text',text:'x'}}));await assert.rejects(discoverGrokTranscript('native-1',[dir]),/ambiguous_transcript/);
 await writeFile(path,'{}\n');await assert.rejects(readGrokTranscript(path,'native-1'),/unsupported_format/);
});
test('Grok caps bytes, marks unknown content partial and handles rewrite reset',async t=>{
 const {path}=await fixture(t);await writeFile(path,notification('a','user_message_chunk',{content:{type:'text',text:'x'}})+notification('b','agent_message_chunk',{content:{type:'image',data:'excluded'}}));
 let r=await readGrokTranscript(path,'native-1');assert.equal(r.checkpoint.status,'partial');assert.equal(r.items.length,1);
 await writeFile(path,notification('c','user_message_chunk',{content:{type:'text',text:'new'}}));r=await readGrokTranscript(path,'native-1',r.checkpoint);assert.equal(r.reset,true);assert.equal(r.items[0].content,'new');
 await appendFile(path,notification('d','agent_message_chunk',{content:{type:'text',text:'a'.repeat(400000)}}));r=await readGrokTranscript(path,'native-1',r.checkpoint);assert.ok(r.bytesRead<=256*1024);assert.equal(r.items.length,0);
 r=await readGrokTranscript(path,'native-1',r.checkpoint);assert.equal(r.items[0].data.truncated,true);assert.ok(r.items[0].content.length<=64*1024);
});
test('Grok 工具调用把 ACP kind 写进 name，参数并进 tool_call 而不是另起一种 part',async t=>{
 const {path}=await fixture(t);
 const rawInput={command:'npm test',script:'x'.repeat(400)};
 await writeFile(path,notification('a','tool_call',{toolCallId:'t1',kind:'execute',title:'Running npm test',status:'in_progress',rawInput}));
 const r=await readGrokTranscript(path,'native-1');
 // 前端靠 name 分派渲染器（frontend/src/features/conversations/tools/identify.ts），
 // 写进去的必须是工具身份；标题是一句话，进了 name 就永远匹配不到渲染器。
 const parts=r.items[0].data.parts;
 assert.deepEqual(parts.map(p=>p.type),['tool_call']);   // 不许再产出 parts.ts 不认识的 tool_input
 assert.equal(parts[0].name,'execute');
 assert.equal(parts[0].toolCallId,'t1');
 // 正文是 `name: 参数`，参数是可解析 JSON——parts.ts 的 toolArgs 剥掉前缀后要能 JSON.parse。
 assert.ok(parts[0].text!.startsWith('execute: {'));
 const preview=JSON.parse(parts[0].text!.slice('execute: '.length));
 assert.equal(preview.command,'npm test');
 assert.equal(preview.script,'x'.repeat(300)+'…[截断 100 字符]');   // 预览态走结构深度截断
 assert.equal(r.items[0].data.truncated,true);
 // 详情态给完整 JSON，不截断。
 const detail=r.details[0].data.parts;
 assert.deepEqual(detail.map(p=>p.type),['tool_call']);
 assert.equal(detail[0].name,'execute');
 assert.equal(detail[0].text,'execute: '+JSON.stringify(rawInput));
});
test('Grok 没有 rawInput 时退回标题，没有 kind 时不编工具名',async t=>{
 const {path}=await fixture(t);
 await writeFile(path,notification('a','tool_call',{toolCallId:'t1',kind:'read',title:'Read src/app.ts'})
  +notification('b','tool_call_update',{toolCallId:'t1',status:'completed',content:[{type:'content',content:{type:'text',text:'ok'}}]}));
 const r=await readGrokTranscript(path,'native-1');
 assert.equal(r.items[0].data.parts[0].name,'read');
 assert.equal(r.items[0].data.parts[0].text,'read: Read src/app.ts');
 // kind 缺席（ACP 不要求每条 update 都重复）：宁可没有名字，也不拿标题冒充。
 const update=r.items[1].data.parts;
 assert.equal(update[0].type,'tool_call');
 assert.equal(update[0].name,undefined);
 assert.equal(update[0].text,'{}');
 assert.equal(update[1].type,'tool_result');
 assert.equal(update[1].text,'ok');
 assert.equal(update[1].name,undefined);
});
