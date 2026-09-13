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
