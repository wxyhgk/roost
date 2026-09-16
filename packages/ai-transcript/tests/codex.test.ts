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
  codex 把 `<environment_context>` 这类机器注入写成普通 user 消息，和真人说的话在记录里
  长得一模一样。本机实测一份转录 12 条 user 里有 3 条是注入——照原样画出来，界面就会
  显示成「你说过这些」，而你从没说过。

  判据不是字符串匹配，是 codex 自己打的标：content_item_kinds。
*/
const meta = (kinds: string[]) => ({ turn_id: 't', create_time: 1, content_item_kinds: kinds });

test('机器注入按 codex 自己打的标识别，不进 content', async t => {
  const path = await fixture(t,
    response({type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>\n  <cwd>/home</cwd>\n</environment_context>'}],
      internal_chat_message_metadata_passthrough:meta(['environments.environment_context'])})+
    response({type:'message',role:'user',content:[{type:'input_text',text:'你好，你看看我们的服务器'}],
      internal_chat_message_metadata_passthrough:meta(['user.text'])}));
  const batch = await readCodexTranscript(path,'native');
  assert.equal(batch.items.length,2);

  const [injected, human] = batch.items;
  assert.equal(injected.data.parts[0].type,'context','注入走 context 通道，不是用户文本');
  assert.equal(injected.data.parts[0].contextLabel,'environments.environment_context');
  // content 是预览取的、搜索扫的。混进去会让目录预览显示成一段 <environment_context>，
  // 也会让搜索在用户从没写过的词上命中他的消息。
  assert.equal(injected.content,'');
  // 一个字都没丢：它在 parts 里。
  assert.ok(injected.data.parts[0].text.includes('<cwd>/home</cwd>'));

  assert.equal(human.data.parts[0].type,'text','真人说的话不能被标成注入');
  assert.equal(human.content,'你好，你看看我们的服务器');
});

test('没有这个标时不猜：照原样当用户文本', async t => {
  // 字段名自带 internal_..._passthrough，是供应商内部结构，可能缺失或改名。
  // 宁可漏标，不可错标——把真人说的话标成机器注入，比反过来更糟。
  const path = await fixture(t,
    response({type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>假装是注入</environment_context>'}]}));
  const batch = await readCodexTranscript(path,'native');
  assert.equal(batch.items[0].data.parts[0].type,'text');
  assert.equal(batch.items[0].content,'<environment_context>假装是注入</environment_context>');
});

test('混着真人文本时不拆：整条仍按用户文本处理', async t => {
  // content_item_kinds 与 content 是否逐项对齐没有验证过，混合情况下按项拆分就是猜。
  const path = await fixture(t,
    response({type:'message',role:'user',content:[{type:'input_text',text:'真话'},{type:'input_text',text:'<environment_context/>'}],
      internal_chat_message_metadata_passthrough:meta(['user.text','environments.environment_context'])}));
  const batch = await readCodexTranscript(path,'native');
  assert.ok(batch.items[0].data.parts.every((part: any) => part.type === 'text'));
  assert.ok(batch.items[0].content.includes('真话'));
});

test('assistant 的消息不受这条判据影响', async t => {
  const path = await fixture(t,
    response({type:'message',role:'assistant',content:[{type:'output_text',text:'回答'}],
      internal_chat_message_metadata_passthrough:meta(['environments.environment_context'])}));
  const batch = await readCodexTranscript(path,'native');
  assert.equal(batch.items[0].data.parts[0].type,'text');
  assert.equal(batch.items[0].content,'回答');
});
