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

/*
  用 Bash 改文件（sed、heredoc、改文件的脚本）时 diff 在另一个键上：`bashEditDiff.files[]`。
  **本机 52 份 transcript 实测 501 条，全部来自 Bash，和 `structuredPatch` 从不同时出现。**
  不取它的后果是「Edit 工具改的文件有 diff，Bash 改的一个都没有」。

  `EditPatch` 是单文件的，所以多文件只能带第一个 + 标 `truncated`；`moreFiles`（Claude 自己
  都没给全的份数）同理。宁可少带，不可假装拿到的就是全部。
*/
test('Bash edits carry their diff too, and say so when more files were changed', async t => {
  const file = await fixture(t);
  const hunk = (n: number) => ({ oldStart: n, oldLines: 2, newStart: n, newLines: 3, lines: [' keep', '-old', '+new'] });
  const result = (uuid: string, blocks: any[], toolUseResult?: any) =>
    encode({ ...row(uuid, 'user', blocks), ...(toolUseResult ? { toolUseResult } : {}) });
  const one = [{ type: 'tool_result', tool_use_id: 'c', content: 'ok' }];
  await writeFile(file,
    encode(row('seed', 'user', 'q'))
    + result('single', one, { bashEditDiff: { files: [{ filePath: '/w/a.ts', hunks: [hunk(4)] }], moreFiles: 0,
        changedFiles: ['/w/a.ts'] } })
    // 多个文件：只带第一个，剩下的用 truncated 说出来。
    + result('many', one, { bashEditDiff: { files: [{ filePath: '/w/a.ts', hunks: [hunk(1)] },
        { filePath: '/w/b.ts', hunks: [hunk(2)] }], moreFiles: 0, changedFiles: ['/w/a.ts', '/w/b.ts'] } })
    // 一个文件，但 Claude 自己就没给全：同样是「不是全部」。
    + result('more', one, { bashEditDiff: { files: [{ filePath: '/w/a.ts', hunks: [hunk(1)] }], moreFiles: 7,
        changedFiles: ['/w/a.ts'] } })
    // files 为空（shared / unavailable 的记录就长这样）：不附，而不是附一个空的。
    + result('empty', one, { bashEditDiff: { files: [], moreFiles: 0, shared: true } })
    + result('unavailable', one, { bashEditDiff: { files: [], moreFiles: 0, unavailable: true } })
    // 字段缺失、类型不对：一律不附，不许抛。
    + result('shapeless', one, { bashEditDiff: { files: [{ filePath: '/w/a.ts' }, { hunks: 'nope' }] } })
    + result('notobject', one, { bashEditDiff: 'nope' })
    // 第一个文件没有 hunk 时跳到下一个有的，不能因此整条丢掉。
    + result('skip', one, { bashEditDiff: { files: [{ filePath: '/w/a.ts', hunks: [] },
        { filePath: '/w/b.ts', hunks: [hunk(9)] }], moreFiles: 0 } })
    // 两条结果：记录级的数据指认不了是哪一条，和 structuredPatch 同一条纪律。
    + result('two', [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
                     { type: 'tool_result', tool_use_id: 'c2', content: 'ok' }],
        { bashEditDiff: { files: [{ filePath: '/w/a.ts', hunks: [hunk(1)] }], moreFiles: 0 } }));

  const parts = (await readClaudeTranscript(file, 'native')).items.map(item => item.data.parts[0]);
  assert.equal(parts[1].patch?.filePath, '/w/a.ts');
  assert.deepEqual(parts[1].patch?.hunks[0].lines, [' keep', '-old', '+new']);
  assert.equal(parts[1].patch?.truncated, false, '一个文件、没有更多：不算截断');
  assert.equal(parts[2].patch?.filePath, '/w/a.ts', '多文件只带第一个');
  assert.equal(parts[2].patch?.truncated, true, '带不下的文件必须说出来');
  assert.equal(parts[3].patch?.truncated, true, 'moreFiles 也是「不是全部」');
  for (const [i, why] of [[4, 'shared'], [5, 'unavailable'], [6, '形状不对'], [7, '不是对象'], [9, '指认不了']] as const)
    assert.equal(parts[i].patch, undefined, why);
  assert.equal(parts[8].patch?.filePath, '/w/b.ts', '跳过没有 hunk 的那个');
});

/* Bash 的 diff 走的是同一条封顶：原始数据可以任意大，而这份要过预览、WebSocket 和列表预算。 */
test('a Bash diff obeys the same bounds as an edit patch', async t => {
  const file = await fixture(t);
  const big = Array.from({ length: 30 }, (_, i) => ({ oldStart: i, oldLines: 1, newStart: i, newLines: 1,
    lines: Array.from({ length: 8 }, () => '+' + 'x'.repeat(400)) }));
  await writeFile(file, encode(row('seed', 'user', 'q'))
    + encode({ ...row('r', 'user', [{ type: 'tool_result', tool_use_id: 'c', content: 'ok' }]),
               toolUseResult: { bashEditDiff: { files: [{ filePath: '/w/big.ts', hunks: big }], moreFiles: 0 } } }));
  const patch = (await readClaudeTranscript(file, 'native')).items[1].data.parts[0].patch!;
  assert.ok(patch.hunks.length <= 20, `hunks=${patch.hunks.length}`);
  assert.ok(patch.hunks.reduce((n, h) => n + h.lines.length, 0) <= 200, '总行数封顶');
  assert.ok(patch.hunks.every(h => h.lines.every(l => l.length <= 300)), '单行封顶');
  assert.equal(patch.truncated, true);
});

/*
  **「用户不让跑」和「跑了但失败」是两件事。** 实测 87 条 is_error 里有 21 条命令根本没执行过
  （用户拒绝 15、auto 模式拦截 5、权限规则 1），一律画成「失败」是在报一个没发生过的错误。

  判据是记录级的 `toolDenialKind`，不是文本匹配——那 21 条全带这个字段，没有一条非拒绝记录
  带它，而 `toolUseResult` 在这些记录上只是个字符串，给不出别的线索。
*/
test('a denied tool use is not a failure', async t => {
  const file = await fixture(t);
  const one = (id: string) => [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: true }];
  await writeFile(file,
    encode(row('seed', 'user', 'q'))
    + encode({ ...row('rejected', 'user', one('c1')), toolDenialKind: 'user-rejected' })
    + encode({ ...row('automode', 'user', one('c2')), toolDenialKind: 'automode-blocked' })
    // 没见过的种类也算拒绝：写死已知值会让将来新增的种类悄悄退回「失败」。
    + encode({ ...row('future', 'user', one('c3')), toolDenialKind: 'some-new-kind' })
    + encode(row('failed', 'user', one('c4')))
    // 成功的结果不许被这个字段改写。
    + encode({ ...row('fine', 'user', [{ type: 'tool_result', tool_use_id: 'c5', content: 'ok' }]),
               toolDenialKind: 'user-rejected' })
    // 空串 / 非字符串不是信号。
    + encode({ ...row('blank', 'user', one('c6')), toolDenialKind: '' })
    + encode({ ...row('bogus', 'user', one('c7')), toolDenialKind: 3 })
    // 两条结果时指认不到具体哪一条，和 patch 同一条门闸。
    + encode({ ...row('two', 'user', [{ type: 'tool_result', tool_use_id: 'c8', content: 'x', is_error: true },
                                      { type: 'tool_result', tool_use_id: 'c9', content: 'x', is_error: true }]),
               toolDenialKind: 'user-rejected' }));
  const types = (await readClaudeTranscript(file, 'native')).items.map(item => item.data.parts[0].type);
  assert.deepEqual(types.slice(1, 4), ['tool_denied', 'tool_denied', 'tool_denied']);
  assert.deepEqual(types.slice(4), ['tool_error', 'tool_result', 'tool_error', 'tool_error', 'tool_error']);
});

/*
  **用量在源头就有，我们原来一个字段都没带出来。** 本机 28 份 transcript / 5219 条非 sidechain
  的 assistant 记录，`message.usage` 命中率 100%，而 `TranscriptItem` 上没有它的位置——
  「这个回合烧了多少上下文」在界面上根本不存在。

  这里钉的是**怎么带不出错**，不是「带了」：坏数据不能崩，缺席的桶不能变成 0。
*/
test('Claude usage travels with the assistant record, bucket by bucket', async t => {
  const file = await fixture(t);
  const assistant = (uuid: string, usage: any, model: any = 'claude-opus-5') =>
    encode({ ...row(uuid, 'assistant', 'reply'), message: { role: 'assistant', content: 'reply', usage, model } });
  // 本机实测的量级：未命中输入个位数，缓存读将近 100 万，输出几百到几千。
  const real = { input_tokens: 2, cache_creation_input_tokens: 8246, cache_read_input_tokens: 30516,
    output_tokens: 423, output_tokens_details: { thinking_tokens: 69 }, service_tier: 'standard',
    iterations: [{ input_tokens: 2, output_tokens: 423, type: 'message' }] };
  await writeFile(file,
    encode(row('seed', 'user', 'q'))
    + assistant('full', real)
    // 只有两个必需桶：三个可选的**缺席**，不许变成 0。
    + assistant('bare', { input_tokens: 10, output_tokens: 20 })
    // 思考桶在本机有 12 条缺席（99.7%），它证明了「缺席不是 0」不是假设。
    + assistant('nodetails', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, output_tokens_details: null })
    // Claude Code 自己塞的报错占位：usage 全零、model 是 `<synthetic>`。零就是零，照带。
    + assistant('synthetic', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, '<synthetic>'));

  const items = (await readClaudeTranscript(file, 'native')).items;
  assert.deepEqual(items[1].data.usage, { inputTokens: 2, outputTokens: 423, cacheReadTokens: 30516,
    cacheWriteTokens: 8246, reasoningTokens: 69, model: 'claude-opus-5' });
  assert.deepEqual(items[2].data.usage, { inputTokens: 10, outputTokens: 20, model: 'claude-opus-5' });
  assert.equal('cacheReadTokens' in items[2].data.usage!, false, '缺席的桶不许出现');
  assert.deepEqual(items[3].data.usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, model: 'claude-opus-5' });
  assert.deepEqual(items[4].data.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, model: '<synthetic>' });
  // 用户消息没有自己的模型请求，也就没有自己的用量。
  assert.equal(items[0].data.usage, undefined);
  // 详情读的是同一条记录，用量必须一致——否则「点开看详情」会看到另一组数。
  assert.deepEqual((await readClaudeDetail(items[1].data.detail))!.data.usage, items[1].data.usage);
});

/*
  **坏数据不能崩，也不能变成一个看着合理的假数。** 字段缺失、类型不对、数值异常三档全走一遍：
  出路只有一条——那个桶（或整条用量）不出现。截断成上限会造出一个说得通的谎，比缺席更糟。
*/
test('Claude usage refuses every malformed shape instead of guessing', async t => {
  const file = await fixture(t);
  const assistant = (uuid: string, message: any) => encode({ ...row(uuid, 'assistant', 'reply'), message: { role: 'assistant', content: 'reply', ...message } });
  await writeFile(file,
    encode(row('seed', 'user', 'q'))
    + assistant('nousage', {})
    + assistant('nullusage', { usage: null })
    + assistant('strusage', { usage: 'lots' })
    + assistant('arrusage', { usage: [1, 2] })
    // 必需桶缺一个 → 整条不给：只有输出没有输入的用量会在总数里少算一块，而界面上看不出来。
    + assistant('noinput', { usage: { output_tokens: 5 } })
    + assistant('nooutput', { usage: { input_tokens: 5 } })
    // 类型不对
    + assistant('strnum', { usage: { input_tokens: '5', output_tokens: 5 } })
    + assistant('objnum', { usage: { input_tokens: { n: 5 }, output_tokens: 5 } })
    // 数值异常：负数、小数、NaN/Infinity（JSON 里写成 null）、超出安全整数、超出上限
    + assistant('negative', { usage: { input_tokens: -1, output_tokens: 5 } })
    + assistant('fraction', { usage: { input_tokens: 1.5, output_tokens: 5 } })
    + assistant('huge', { usage: { input_tokens: 1e13, output_tokens: 5 } })
    + assistant('unsafe', { usage: { input_tokens: 5, output_tokens: 1e300 } })
    // 坏掉的只是可选桶 → 只丢那个桶，必需的两个照常带
    + assistant('badcache', { usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: -3, cache_creation_input_tokens: 'x' } })
    + assistant('badthink', { usage: { input_tokens: 5, output_tokens: 6, output_tokens_details: { thinking_tokens: 2.5 } } })
    + assistant('thinkarr', { usage: { input_tokens: 5, output_tokens: 6, output_tokens_details: [] } })
    // model 的类型与长度：非字符串和空串按没有，超长截断（它只是个标签，不进任何求和）
    + assistant('nomodel', { usage: { input_tokens: 5, output_tokens: 6 }, model: 42 })
    + assistant('blankmodel', { usage: { input_tokens: 5, output_tokens: 6 }, model: '' })
    + assistant('longmodel', { usage: { input_tokens: 5, output_tokens: 6 }, model: 'm'.repeat(500) }));

  const items = (await readClaudeTranscript(file, 'native')).items;
  const by = (uuid: string) => items.find(item => item.data.nativeMessageId === uuid)!.data.usage;
  for (const uuid of ['nousage', 'nullusage', 'strusage', 'arrusage', 'noinput', 'nooutput',
    'strnum', 'objnum', 'negative', 'fraction', 'huge', 'unsafe'])
    assert.equal(by(uuid), undefined, uuid + ' 不该有用量');
  assert.deepEqual(by('badcache'), { inputTokens: 5, outputTokens: 6 });
  assert.deepEqual(by('badthink'), { inputTokens: 5, outputTokens: 6 });
  assert.deepEqual(by('thinkarr'), { inputTokens: 5, outputTokens: 6 });
  assert.deepEqual(by('nomodel'), { inputTokens: 5, outputTokens: 6 });
  assert.deepEqual(by('blankmodel'), { inputTokens: 5, outputTokens: 6 });
  assert.equal(by('longmodel')!.model!.length, 128);
  // 一条记录都不许因为用量而丢
  assert.equal(items.length, 19);
});
