import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewToolArgs,previewToolText,truncateDeep,PREVIEW_ARG_LIMITS } from '../src/truncate.ts';
import { createServer } from 'node:http';
import { readClaudeTranscript } from '../src/claude.ts';
import { readGeminiTranscript } from '../src/gemini.ts';
import { readOpenCodeTranscript } from '../src/opencode.ts';
const row=(uuid:string,role='assistant',content:any='hello')=>({type:role,uuid,sessionId:'native',parentUuid:null,timestamp:'2026-09-09T00:00:00Z',message:{role,content}});
const encode=(value:any)=>JSON.stringify(value)+'\n';

test('deep truncation keeps the shape and says what it cut',()=>{
  const {maxString,maxArray,maxObjectKeys,maxDepth}=PREVIEW_ARG_LIMITS;
  // 形状不变、短值原样：以前这里整份参数只剩一个标量。
  assert.deepEqual(truncateDeep({pattern:'foo.*',glob:'*.ts',head_limit:5}),
    {value:{pattern:'foo.*',glob:'*.ts',head_limit:5},truncated:false});
  // 超长字符串：截断并报出砍了多少字符。
  const long=truncateDeep({command:'x'.repeat(maxString+42)});
  assert.equal(long.truncated,true);
  assert.equal((long.value as any).command,'x'.repeat(maxString)+`…[截断 42 字符]`);
  // 超长数组：保留前 maxArray 项，末尾补一条报数。
  const many=truncateDeep({todos:Array.from({length:maxArray+3},(_,i)=>i)});
  assert.equal(many.truncated,true);
  assert.deepEqual((many.value as any).todos,[...Array.from({length:maxArray},(_,i)=>i),'…[截断 3 项]']);
  // 键数超限：砍掉多余的键，记数而不是记键名。
  const wide=truncateDeep(Object.fromEntries(Array.from({length:maxObjectKeys+7},(_,i)=>[`k${i}`,i])));
  assert.equal(wide.truncated,true);
  assert.equal(Object.keys(wide.value as object).length,maxObjectKeys+1);
  assert.equal((wide.value as any)._truncatedKeys,7);
  // 超过深度：占位符收尾，不再往下走。
  let deep:any='bottom';for(let i=0;i<maxDepth+2;i++)deep={nested:deep};
  const bounded=truncateDeep(deep);assert.equal(bounded.truncated,true);
  assert.match(JSON.stringify(bounded.value),/\[超出深度\]/);
  assert.doesNotMatch(JSON.stringify(bounded.value),/bottom/);
});

test('preview arguments survive odd shapes without throwing',()=>{
  assert.deepEqual(previewToolArgs({}),{text:'{}',truncated:false});
  assert.deepEqual(previewToolArgs(undefined),{text:'{}',truncated:false});
  assert.deepEqual(previewToolArgs(null),{text:'null',truncated:false});
  // 非对象参数照 JSON 原样序列化，前端解不出对象时仍有 raw 顶着。
  assert.deepEqual(previewToolArgs('plain'),{text:'"plain"',truncated:false});
  assert.deepEqual(previewToolArgs(7),{text:'7',truncated:false});
  assert.deepEqual(previewToolArgs([1,2]),{text:'[1,2]',truncated:false});
  // 自由文本参数不套 JSON 引号，但一样受字符串上限约束。
  assert.deepEqual(previewToolText('short'),{text:'short',truncated:false});
  assert.equal(previewToolText('y'.repeat(PREVIEW_ARG_LIMITS.maxString+1)).truncated,true);
});

test('Claude previews carry whole argument objects while details stay complete',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'truncate-claude-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'native.jsonl');
  const big='z'.repeat(PREVIEW_ARG_LIMITS.maxString+100);
  await writeFile(file,encode(row('u','user','question'))
    +encode(row('a','assistant',[{type:'tool_use',id:'c1',name:'Grep',input:{pattern:'needle',path:'/tmp',output_mode:'content','-n':true}}]))
    +encode(row('b','assistant',[{type:'tool_use',id:'c2',name:'Edit',input:{file_path:'/tmp/x.ts',old_string:big}}])));
  const b=await readClaudeTranscript(file,'native');
  const preview=b.items[1].data.parts[0],detail=b.details[1].data.parts[0];
  // 前端的 toolArgs() 靠 `name + ": "` 剥名字，这个前缀必须还在。
  assert.equal(preview.name,'Grep');assert.ok(preview.text!.startsWith('Grep: '));
  assert.deepEqual(JSON.parse(preview.text!.slice('Grep: '.length)),{pattern:'needle',path:'/tmp',output_mode:'content','-n':true});
  assert.equal(b.items[1].data.truncated,false);
  assert.equal(detail.text,'Grep: '+JSON.stringify({pattern:'needle',path:'/tmp',output_mode:'content','-n':true}));
  // 超长字段在预览里被截断并标记，详情里仍是完整的。
  assert.match(b.items[2].data.parts[0].text!,/截断 100 字符/);
  assert.equal(b.items[2].data.truncated,true);
  assert.ok(b.details[2].data.parts[0].text!.includes(big));
  assert.equal(b.details[2].data.truncated,false);
});

test('empty and non-object tool arguments reach previews intact',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'truncate-empty-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'native.jsonl');
  await writeFile(file,encode(row('u','user','question'))
    +encode(row('a','assistant',[{type:'tool_use',id:'c1',name:'ListMcpResources'},
                                 {type:'tool_use',id:'c2',name:'Weird',input:'raw-text'}])));
  const b=await readClaudeTranscript(file,'native');
  assert.equal(b.items[1].data.parts[0].text,'ListMcpResources: {}');
  assert.equal(b.items[1].data.parts[1].text,'Weird: "raw-text"');
  assert.equal(b.items[1].data.truncated,false);
});

test('Gemini and OpenCode snapshots truncate tool arguments in previews only',async t=>{
  const big='q'.repeat(PREVIEW_ARG_LIMITS.maxString+8);
  const dir=await mkdtemp(join(tmpdir(),'truncate-gemini-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'session.json');
  await writeFile(file,JSON.stringify({sessionId:'native',projectHash:'project',startTime:'2026-09-09T00:00:00Z',messages:[
    {id:'a',type:'gemini',timestamp:'2026-09-09T00:00:01Z',content:'reply',
     toolCalls:[{id:'t',name:'replace',args:{file_path:'/tmp/x',new_string:big},status:'success'}]}]}));
  const g=await readGeminiTranscript(file,'native');
  const call=g.items[0].data.parts.find(p=>p.type==='tool_call')!;
  // gemini 本来就没有 `name: ` 前缀，这次不改它——前端靠 part.name 认名字。
  assert.ok(call.text!.startsWith('{'));assert.equal(call.name,'replace');
  assert.match(call.text!,/截断 8 字符/);assert.equal(g.items[0].data.truncated,true);
  const detail=g.details[0].data.parts.find(p=>p.type==='tool_call')!;
  assert.ok(detail.text!.includes(big));assert.equal(g.details[0].data.truncated,false);

  const rows=[{info:{id:'msg_a',sessionID:'ses_test',role:'assistant',time:{created:200}},
    parts:[{type:'tool',tool:'edit',callID:'call_x',state:{status:'completed',input:{filePath:'/tmp/x',newString:big},output:'ok'}}]}];
  const session={id:'ses_test',time:{created:100},directory:'/tmp/test'};
  const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');
    if(req.url?.startsWith('/session/status')){res.end('{}');return;}
    res.end(JSON.stringify(req.url?.includes('/message')?rows:session));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const o=await readOpenCodeTranscript(`http://127.0.0.1:${(server.address() as any).port}/?directory=%2Ftmp%2Ftest`,'ses_test');
  const oc=o.items[0].data.parts[0];
  assert.ok(oc.text!.startsWith('{'));assert.equal(oc.name,'edit');
  assert.match(oc.text!,/截断 8 字符/);assert.equal(o.items[0].data.truncated,true);
  assert.ok(o.details[0].data.parts[0].text!.includes(big));assert.equal(o.details[0].data.truncated,false);
});

test('a Gemini edit hidden behind the preview truncation still resets the snapshot',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'truncate-reset-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'session.json');
  const write=(tail:string)=>writeFile(file,JSON.stringify({sessionId:'native',projectHash:'project',startTime:'2026-09-09T00:00:00Z',
    messages:[{id:'a',type:'gemini',timestamp:'2026-09-09T00:00:01Z',content:'reply',
      toolCalls:[{id:'t',name:'replace',args:{new_string:'q'.repeat(PREVIEW_ARG_LIMITS.maxString+8)+tail},status:'success'}]}]}));
  await write('AAA');const first=await readGeminiTranscript(file,'native');
  assert.equal((await readGeminiTranscript(file,'native',first.checkpoint)).reset,false);
  // 改动整个落在被截掉的尾巴里，预览一个字都没变。快照仍然认得出来，靠的是每条 item 的
  // detail.hash 按原始记录算——截断参数不会把这条路弄瞎，这里钉住它。
  await write('BBB');const edited=await readGeminiTranscript(file,'native',first.checkpoint);
  assert.equal(edited.reset,true);assert.ok(edited.details[0].data.parts.some(p=>p.text?.includes('BBB')));
});
