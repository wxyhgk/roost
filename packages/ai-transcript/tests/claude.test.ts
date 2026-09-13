import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,appendFile,rm,rename,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeTranscript,readClaudeDetail,discoverClaudeTranscript } from '../src/claude.ts';
import type { TranscriptCheckpoint } from '../src/index.ts';
const row=(uuid:string,role='assistant',content:any='hello')=>({type:role,uuid,sessionId:'native',parentUuid:null,timestamp:'2026-09-09T00:00:00Z',message:{role,content}});
const encode=(value:any)=>JSON.stringify(value)+'\n';
async function fixture(t:any){const dir=await mkdtemp(join(tmpdir(),'claude-reader-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'native.jsonl');}
test('Claude tool calls, results, thinking, identities and safe durable details',async t=>{
 const file=await fixture(t);await writeFile(file,encode(row('u','user','question'))+encode(row('a','assistant',[{type:'thinking',thinking:'recorded',signature:'secret'},{type:'tool_use',id:'call',name:'Bash',input:{command:'pwd',timeout:100}}]))+encode(row('r','user',[{type:'tool_result',tool_use_id:'call',content:'x'.repeat(9000),is_error:true}])));
 const b=await readClaudeTranscript(file,'native');assert.equal(b.items.length,3);assert.equal(b.items[2].role,'tool');assert.equal(b.items[2].data.parts[0].toolCallId,'call');assert.equal(b.items[2].data.parts[0].type,'tool_error');assert.equal(b.items[2].content.length,4000);assert.equal(b.details[2].content.length,9000);assert.doesNotMatch(JSON.stringify(b.details),/secret|signature/);assert.match(b.details[1].content,/timeout/);assert.deepEqual(await readClaudeDetail(b.items[2].data.detail),b.details[2]);
 await assert.rejects(readClaudeTranscript(file,'wrong'),/session_mismatch/);
 await writeFile(file,encode(row('changed')));await assert.rejects(readClaudeDetail(b.items[0].data.detail),/file_changed/);
});
test('Claude partial UTF8, restart cursor, replacement and stable duplicate/revision IDs',async t=>{
 const file=await fixture(t);await writeFile(file,encode(row('seed','user'))+encode(row('a','assistant','分子'.repeat(70000)))+JSON.stringify(row('pending')));
 let cp:TranscriptCheckpoint|undefined;const ids:string[]=[];
 for(let i=0;i<5;i++){const b=await readClaudeTranscript(file,'native',cp);cp=b.checkpoint;assert.ok(b.bytesRead<=256*1024);ids.push(...b.items.map(e=>e.eventId));if(cp.offset===cp.fileSize)break;}
 assert.deepEqual(ids,['claude:native:seed','claude:native:a']);assert.equal(cp!.status,'awaiting_line');await appendFile(file,'\n'+encode(row('pending','assistant','revised')));const b=await readClaudeTranscript(file,'native',cp);assert.equal(b.items[0].eventId,b.items[1].eventId);assert.notEqual(b.items[0].content,b.items[1].content);assert.equal((await readClaudeTranscript(file,'native',b.checkpoint)).bytesRead,0);
 await writeFile(file+'.new',encode(row('new')));await rename(file+'.new',file);assert.equal((await readClaudeTranscript(file,'native',b.checkpoint)).reset,true);
});
test('Claude skips oversized and unsupported sidechains explicitly and validates every row',async t=>{
 const file=await fixture(t);await writeFile(file,encode(row('seed'))+encode(row('large','user','x'.repeat(1200000)))+encode({...row('child'),isSidechain:true})+encode({type:'system',subtype:'compact_boundary',sessionId:'native'})+encode(row('last')));
 let cp:TranscriptCheckpoint|undefined;const ids:string[]=[];for(let i=0;i<10;i++){const b=await readClaudeTranscript(file,'native',cp);cp=b.checkpoint;ids.push(...b.items.map(e=>e.eventId));if(cp.offset===cp.fileSize)break;}
 assert.deepEqual(ids,['claude:native:seed','claude:native:last']);assert.equal(cp!.skipped,3);assert.equal(cp!.status,'partial');await appendFile(file,encode({...row('wrong'),sessionId:'other'}));await assert.rejects(readClaudeTranscript(file,'native',cp),/session_mismatch/);
});
test('Claude discovery uses exact identity filename and rejects ambiguity',async t=>{
 const file=await fixture(t);await writeFile(file,encode(row('a')));const dir=join(file,'..');assert.equal(await discoverClaudeTranscript('native',[dir]),file);await mkdir(join(dir,'project'));await writeFile(join(dir,'project','native.jsonl'),encode(row('a')));await assert.rejects(discoverClaudeTranscript('native',[dir]),/ambiguous/);await assert.rejects(discoverClaudeTranscript('../native',[dir]),/invalid_native_id/);
});

/*
  文件改动的真实 hunk 就在数据里——Claude 把解析好的 unified hunk 放在记录级的
  `toolUseResult.structuredPatch` 上（本机 12 份 transcript 实测有 30 条非空）。
  **原来只读 `content` 里的纯文本，于是把「它到底改了什么」压成了一行「Edit: 路径」**，
  而那恰恰是 AI coding 对话里用户最关心的东西。

  记录级的数据只对应一条结果：一条记录里有多个 tool_result 时无法指认是哪一个，就不附。
*/
test('Claude edit results carry the real patch, bounded, and only when unambiguous', async t => {
  const file = await fixture(t);
  const hunk = (n: number) => ({ oldStart: n, oldLines: 2, newStart: n, newLines: 3, lines: [' keep', '-old', '+new'] });
  const result = (uuid: string, blocks: any[], toolUseResult?: any) =>
    encode({ ...row(uuid, 'user', blocks), ...(toolUseResult ? { toolUseResult } : {}) });
  await writeFile(file,
    encode(row('seed', 'user', 'q'))
    + result('one', [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }],
      { filePath: '/w/src/a.ts', structuredPatch: [hunk(4), hunk(40)] })
    // 两条结果 + 一份记录级改动：指认不了是哪条的，不附。
    + result('two', [{ type: 'tool_result', tool_use_id: 'c2', content: 'ok' },
                     { type: 'tool_result', tool_use_id: 'c3', content: 'ok' }],
      { filePath: '/w/src/b.ts', structuredPatch: [hunk(1)] })
    // 空的 structuredPatch（Write 新建文件就是这样）不算改动。
    + result('three', [{ type: 'tool_result', tool_use_id: 'c4', content: 'ok' }],
      { filePath: '/w/src/c.ts', structuredPatch: [] }));

  const batch = await readClaudeTranscript(file, 'native');
  const patched = batch.items[1].data.parts[0];
  assert.equal(patched.patch?.filePath, '/w/src/a.ts');
  assert.deepEqual(patched.patch?.hunks.map(h => h.oldStart), [4, 40]);
  assert.deepEqual(patched.patch?.hunks[0].lines, [' keep', '-old', '+new']);
  assert.equal(patched.patch?.truncated, false);
  assert.equal(batch.items[2].data.parts[0].patch, undefined, '指认不了就不附');
  assert.equal(batch.items[3].data.parts[0].patch, undefined, '空 patch 不算改动');
});

/* 原始数据可以任意大，而这份要过预览、WebSocket 和列表预算。超限要标出来，不能装作完整。 */
test('an oversized patch is bounded and says so', async t => {
  const file = await fixture(t);
  // 三项上限都要超，但整行要留在单批读取预算内——否则这条记录压根不会被读进来。
  const big = Array.from({ length: 30 }, (_, i) => ({ oldStart: i, oldLines: 1, newStart: i, newLines: 1,
    lines: Array.from({ length: 8 }, () => '+' + 'x'.repeat(400)) }));
  await writeFile(file, encode(row('seed', 'user', 'q'))
    + encode({ ...row('r', 'user', [{ type: 'tool_result', tool_use_id: 'c', content: 'ok' }]),
               toolUseResult: { filePath: '/w/big.ts', structuredPatch: big } }));
  const patch = (await readClaudeTranscript(file, 'native')).items[1].data.parts[0].patch!;
  assert.ok(patch.hunks.length <= 20, `hunks=${patch.hunks.length}`);
  assert.ok(patch.hunks.reduce((n, h) => n + h.lines.length, 0) <= 200, '总行数封顶');
  assert.ok(patch.hunks.every(h => h.lines.every(l => l.length <= 300)), '单行封顶');
  assert.equal(patch.truncated, true);
});
