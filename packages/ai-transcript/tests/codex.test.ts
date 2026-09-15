import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexTranscript, readCodexDetail } from '../src/codex.ts';
const line = (row: unknown) => JSON.stringify(row) + '\n';
const header = line({type:'session_meta',payload:{id:'native',cli_version:'0.153.4'}});
const response = (payload: unknown) => line({type:'response_item',timestamp:'2026-09-09T00:00:00Z',payload});
async function fixture(t: any, content: string) {
  const dir = await mkdtemp(join(tmpdir(),'codex-adapter-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const path = join(dir,'rollout.jsonl'); await writeFile(path,header+content); return path;
}
test('canonical response items avoid event mirrors; tools correlate and details are bounded', async t => {
  const path = await fixture(t,
    line({type:'event_msg',payload:{type:'user_message',message:'hello'}})+
    response({type:'message',role:'user',content:[{type:'input_text',text:'hello'}]})+
    response({type:'function_call',call_id:'tool1',name:'exec_command',arguments:'{"cmd":"echo hello"}'})+
    response({type:'function_call_output',call_id:'tool1',output:'x'.repeat(9000)})+
    response({type:'reasoning',summary:[{type:'summary_text',text:'recorded summary'}],encrypted_content:'DO_NOT_EXPOSE'})+
    response({type:'message',id:'answer',role:'assistant',content:[{type:'output_text',text:'done'}]})+
    line({type:'event_msg',payload:{type:'agent_message',message:'done'}}));
  const batch = await readCodexTranscript(path,'native');
  assert.equal(batch.items.length,5); assert.equal(batch.checkpoint.status,'caught_up');
  assert.equal(batch.items[1].data.parts[0].toolCallId,'tool1');
  assert.equal(batch.items[2].data.parts[0].toolCallId,'tool1');
  assert.equal(batch.items[2].content.length,4000); assert.equal(batch.items[2].data.truncated,true);
  assert.equal((await readCodexDetail(batch.items[2].data.detail))!.content.length,9000);
  assert.equal(batch.details[2].content.length,9000);
  assert.ok(!JSON.stringify(batch).includes('DO_NOT_EXPOSE'));
  assert.equal((await readCodexTranscript(path,'native',batch.checkpoint)).items.length,0);
  await appendFile(path,line({type:'event_msg',payload:{type:'agent_message',message:'done'}}));
  assert.equal((await readCodexTranscript(path,'native',batch.checkpoint)).items.length,0);
});
test('resumes UTF8 partial lines, caps reads and gives stable replay identities', async t => {
  const text = '化学'.repeat(60000);
  const entry = response({type:'message',role:'user',content:[{type:'input_text',text}]});
  const path = await fixture(t,entry.slice(0,-1));
  const first = await readCodexTranscript(path,'native'); assert.ok(first.bytesRead<=256*1024);
  const second = await readCodexTranscript(path,'native',JSON.parse(JSON.stringify(first.checkpoint)));
  assert.equal(second.checkpoint.status,'awaiting_line'); assert.equal(second.items.length,0);
  await appendFile(path,'\n');
  const third = await readCodexTranscript(path,'native',second.checkpoint); assert.equal(third.items.length,1);
  const replay1 = await readCodexTranscript(path,'native');
  const replay2 = await readCodexTranscript(path,'native',replay1.checkpoint);
  assert.equal(third.items[0].eventId,replay2.items[0].eventId);
  assert.equal(third.details[0].content,text);
});
test('identity rejection includes child rollouts; unknown compact and rollback are partial', async t => {
  const path = await fixture(t,line({type:'compacted',payload:{message:'summary'}})+line({type:'event_msg',payload:{type:'session_rollback',num_turns:1}})+response({type:'future_item'}));
  await assert.rejects(readCodexTranscript(path,'parent'),/session_mismatch/);
  const batch = await readCodexTranscript(path,'native'); assert.equal(batch.checkpoint.skipped,3); assert.equal(batch.checkpoint.status,'partial');
  await appendFile(path,line({type:'session_meta',payload:{id:'child'}}));
  await assert.rejects(readCodexTranscript(path,'native',batch.checkpoint),/session_mismatch/);
});
test('oversized rows recover; replaced source resets and invalidates old details', async t => {
  const path = await fixture(t,response({type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(1100000)}]})+response({type:'message',id:'small',role:'assistant',content:[{type:'output_text',text:'ok'}]}));
  let batch=await readCodexTranscript(path,'native'); const items=[...batch.items];
  while(batch.checkpoint.offset<batch.checkpoint.fileSize) {batch=await readCodexTranscript(path,'native',batch.checkpoint);items.push(...batch.items);}
  assert.equal(batch.checkpoint.skipped,1); assert.equal(items.length,1);
  await writeFile(path+'.new',header+response({type:'message',role:'user',content:[{type:'input_text',text:'new'}]}));
  await rename(path+'.new',path);
  const replacement=await readCodexTranscript(path,'native',batch.checkpoint);assert.equal(replacement.reset,true);
  await assert.rejects(readCodexDetail(items[0].data.detail),/file_replaced/);
});

/*
  codex 这边和 Claude `attachment` 对得上的只有 `world_state`——一份环境与指令的快照。
  它此前撞在 `response_item` 那道门闸上被当成解析失败计进 `skipped`。

  只认这一种：本机只有一份 codex rollout、3 条 `world_state`，证据量不足以再分档，
  而配置快照本来就属于「留着、折起来」那一档。`turn_context` / `token_usage_record` /
  `thread_settings_applied` 仍然按原样处理，这里一并钉住，免得将来误以为都认了。
*/
test('codex world_state becomes a collapsed context part; its neighbours keep their old handling', async t => {
  const path = await fixture(t,
    line({ type: 'world_state', timestamp: '2026-09-09T00:00:00Z',
      payload: { full: true, state: { environments: { current_date: '2026-09-13' }, model: 'gpt-6-astra' } } })
    + line({ type: 'thread_settings_applied', timestamp: '2026-09-09T00:00:00Z', payload: { model: 'gpt-6-astra' } })
    + response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }));
  const batch = await readCodexTranscript(path, 'native');
  const ctx = batch.items.filter(item => item.role === 'context');
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].data.parts[0].context!.kind, 'world_state');
  assert.equal(ctx[0].data.parts[0].context!.tier, 'collapsed');
  // 没有 `rendered` 这样的现成文本，走结构化 JSON 兜底：看得懂比看不见强。
  assert.match(ctx[0].data.parts[0].text!, /gpt-6-astra/);
  assert.equal(ctx[0].data.parts[0].context!.length, ctx[0].data.parts[0].text!.length);
  assert.equal(batch.checkpoint.skipped, 1, 'thread_settings_applied 仍然按漏读计——那是另一个决定');
});
