import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQwenTranscript, readQwenDetail, discoverQwenTranscript } from '../src/qwen.ts';
const row = (uuid: string, type: string, parts: unknown[], extra = {}) => ({uuid, sessionId:'native-qwen',parentUuid:null,timestamp:'2026-09-09T00:00:00Z',type,message:{role:type==='assistant'?'model':'user',parts},...extra});
test('Qwen native parts, display text, tools and incremental identity', async () => {
 const dir=await mkdtemp(join(tmpdir(),'qwen-reader-')),path=join(dir,'native-qwen.jsonl');
 try {
  await writeFile(path,[row('u','user',[{text:'original + injected hook'}],{systemPayload:{displayText:'original'}}),row('a','assistant',[{text:'thinking',thought:true},{functionCall:{id:'call-1',name:'run_shell_command',args:{command:'pwd'}}}]),row('t','tool_result',[{functionResponse:{id:'call-1',name:'run_shell_command',response:{output:'x'.repeat(10000)}}}])].map(v=>JSON.stringify(v)+'\n').join(''));
  const first=await readQwenTranscript(path,'native-qwen');
  assert.deepEqual(first.items.map(v=>v.role),['user','assistant','tool']);assert.equal(first.items[0].content,'original');
  /*
    **注入不许被丢掉。** fixture 里 parts 是 `original + injected hook`、displayText 是
    `original`——那个 hook 曾经从来没画出来过：解析器有 displayText 就只画它、parts 整个跳过。
    气泡里仍然只该有 `original`（用户没说过那个 hook），但 hook 要作为一段注入留下来。
  */
  assert.deepEqual(first.items[0].data.parts.map(p=>p.type),['text','context'],'用户那段之外还要有一段注入');
  assert.equal(first.items[0].data.parts[1].text,' + injected hook','注入是掐掉前缀之后剩下的那截');assert.equal(first.items[1].data.parts[1].toolCallId,'call-1');assert.equal(first.items[2].data.truncated,true);
  assert.ok((await readQwenDetail(first.items[2].data.detail))!.content.length>4000);
  const unchanged=await readQwenTranscript(path,'native-qwen',first.checkpoint);assert.equal(unchanged.bytesRead,0);assert.equal(unchanged.items.length,0);
  await appendFile(path,JSON.stringify(row('u2','user',[{text:'你好'}]))+'\n');
  const next=await readQwenTranscript(path,'native-qwen',first.checkpoint);assert.equal(next.items.length,1);assert.equal(next.items[0].eventId,'qwen:native-qwen:u2');
  await assert.rejects(readQwenTranscript(path,'other'),/session_mismatch/);
 } finally {await rm(dir,{recursive:true,force:true})}
});
test('Qwen split UTF8, bounded reads, discovery and unsupported records',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qwen-reader-')),chats=join(dir,'project','chats'),path=join(chats,'native-qwen.jsonl');
 try {await mkdir(chats,{recursive:true});await writeFile(path,JSON.stringify(row('first','user',[{text:'x'}]))+'\n');
  const first=await readQwenTranscript(path,'native-qwen');const line=Buffer.from(JSON.stringify(row('next','assistant',[{text:'你'.repeat(100000)}]))+'\n');await appendFile(path,line);
  const batch=await readQwenTranscript(path,'native-qwen',first.checkpoint);assert.ok(batch.bytesRead<=256*1024);assert.equal(batch.items.length,0);
  const last=await readQwenTranscript(path,'native-qwen',batch.checkpoint);assert.equal(last.items.length,1);assert.ok(!last.items[0].content.includes('�'));assert.equal(last.items[0].data.truncated,true);
  assert.equal(await discoverQwenTranscript('native-qwen',[dir]),path);
  await appendFile(path,JSON.stringify(row('media','user',[{inlineData:{data:'fake'}}]))+'\n');const partial=await readQwenTranscript(path,'native-qwen',last.checkpoint);assert.equal(partial.checkpoint.status,'partial');
 }finally{await rm(dir,{recursive:true,force:true})}
});
