import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImagePaste, type ImagePasteState, type PasteTarget } from '../src/features/terminal/imagePaste.ts';

function fixture() {
  let target: PasteTarget | null = {sessionId:'s',instanceId:'i',epoch:1};
  let state: ImagePasteState = null;
  const sent: string[] = [], revoked: string[] = [];
  let uploads = 0;
  let resolveUpload!: (value: any) => void;
  let rejectUpload!: (error: Error) => void;
  let signal!: AbortSignal;
  const controller = createImagePaste({
    target:()=>target, send:data=>sent.push(data), state:value=>{state=value}, preview:()=> 'blob:preview', revoke:url=>revoked.push(url),
    upload:(_file,_target,s)=>{uploads++;signal=s;return new Promise((resolve,reject)=>{resolveUpload=resolve;rejectUpload=reject})},
  });
  const reply = (insertion: any = {kind:'paste',cli:'codex'}) => resolveUpload({ sessionId:'s',instanceId:'i',path:"/tmp/user's picture.png",insertion });
  const event = (type='image/png',size=1) => {
    let prevented=false, stopped=false;
    const file=new File([new Uint8Array(size)],'image.png',{type});
    return { clipboardData:{items:[{kind:type==='text/plain'?'string':'file',type,getAsFile:()=>file}]},
      preventDefault(){prevented=true},stopImmediatePropagation(){stopped=true},
      get prevented(){return prevented},get stopped(){return stopped} } as unknown as ClipboardEvent & {prevented:boolean;stopped:boolean};
  };
  return {controller,event,reply,sent,revoked,reject:(error:Error)=>rejectUpload(error), get state(){return state},get uploads(){return uploads}, get signal(){return signal},setTarget:(value:PasteTarget|null)=>{target=value}};
}

test('text paste passes through; image upload automatically inserts one Codex quoted path without Enter', async()=>{
  const f=fixture();const text=f.event('text/plain');await f.controller.paste(text);assert.equal(text.prevented,false);assert.equal(f.uploads,0);
  const image=f.event();const done=f.controller.paste(image);assert.ok(image.prevented&&image.stopped);assert.equal(f.state?.phase,'uploading');
  assert.deepEqual(f.sent,[]);f.reply();await done;
  f.controller.insert();assert.equal(f.sent.length,1);assert.equal(f.sent[0],"\x1b[200~'/tmp/user'\\''s picture.png'\x1b[201~");
  assert.equal(f.state?.phase,'inserted');f.controller.dispose();assert.deepEqual(f.revoked,['blob:preview']);
});

test('connection replacement rejects a delayed upload and never sends to another session', async()=>{
  const f=fixture();const done=f.controller.paste(f.event());f.setTarget({sessionId:'other',instanceId:'i',epoch:1});f.reply();await done;
  assert.equal(f.state?.phase,'error');f.controller.insert();assert.deepEqual(f.sent,[]);f.controller.dispose();
});

test('same-instance reconnect during upload blocks automatic insertion', async()=>{
  const f=fixture();const done=f.controller.paste(f.event());
  f.setTarget({sessionId:'s',instanceId:'i',epoch:2});f.reply();await done;f.controller.insert();assert.equal(f.state?.phase,'error');assert.deepEqual(f.sent,[]);f.controller.dispose();
});

test('cancel aborts upload and ignores a late successful response', async()=>{
  const f=fixture();const done=f.controller.paste(f.event());f.controller.cancel();assert.equal(f.signal.aborted,true);
  f.reply();await done;assert.equal(f.state,null);assert.deepEqual(f.sent,[]);assert.deepEqual(f.revoked,['blob:preview']);f.controller.dispose();
});

test('size/type/readiness errors are visible without an upload; failures can be retried', async()=>{
  const f=fixture();await f.controller.paste(f.event('image/gif'));assert.equal(f.state?.phase,'error');
  await f.controller.paste(f.event('image/png',10*1024*1024+1));assert.equal(f.uploads,0);
  f.setTarget(null);await f.controller.paste(f.event());assert.equal(f.uploads,0);
  f.setTarget({sessionId:'s',instanceId:'i',epoch:1});const failed=f.controller.paste(f.event());f.reject(new Error('disk full'));await failed;
  assert.equal(f.state?.message,'disk full');const retried=f.controller.paste(f.event());f.reply();await retried;assert.equal(f.state?.phase,'inserted');assert.equal(f.sent.length,1);f.controller.dispose();
});

test('unknown CLI upload shows an error and never inserts a path', async()=>{
  const f=fixture();const done=f.controller.paste(f.event());
  f.reply({kind:'unsupported',reason:'unknown-cli'});await done;
  assert.equal(f.state?.phase,'error');assert.deepEqual(f.sent,[]);f.controller.dispose();
});

/*
  从系统里拖一张图进终端，和粘贴完全同义。

  截图工具、聊天软件里更自然的动作是拖而不是复制，而这条路以前什么都不做——上传和插入
  的两半零件一直都在，只差这个入口。所以下面钉的是「两条路汇到同一处」，不是新逻辑。
*/
const transfer = (...files: File[]) => ({ files } as unknown as DataTransfer);
const png = (size = 1) => new File([new Uint8Array(size)], 'shot.png', { type: 'image/png' });

test('拖进来的图走的是和粘贴同一条路：上传、拿路径、按 CLI 的规矩插进去', async () => {
  const f = fixture();
  const done = f.controller.drop(transfer(png()));
  assert.equal(f.state?.phase, 'uploading');
  f.reply();
  assert.equal(await done, true, '收下了要说一声，调用方据此不再走它自己的拖放处理');
  f.controller.insert();
  assert.equal(f.sent[0], "\x1b[200~'/tmp/user'\\''s picture.png'\x1b[201~");
  f.controller.dispose();
});

/*
  应用内部的拖放（文件树把路径拖到终端）走的是另一条：`ROOST_PATH_MIME`，它的 files 是
  空的。这里必须原样放过去，否则那条路会被这条截胡。
*/
test('没有文件的拖放不接，交还给调用方', async () => {
  const f = fixture();
  assert.equal(await f.controller.drop(transfer()), false);
  assert.equal(await f.controller.drop(null), false);
  assert.equal(f.uploads, 0);
  assert.equal(f.state, null, '不是我们的事就别在界面上留下痕迹');
  f.controller.dispose();
});

test('非图片的文件当场说清楚，而不是悄悄不动', async () => {
  const f = fixture();
  await f.controller.drop(transfer(new File(['x'], 'notes.txt', { type: 'text/plain' })));
  assert.equal(f.state, null, '压根不是图片，连提示都不该有——那是别人的拖放');
  await f.controller.drop(transfer(new File(['x'], 'photo.gif', { type: 'image/gif' })));
  assert.equal(f.state?.phase, 'error', '是图片但格式不收，就得说出来');
  f.controller.dispose();
});

test('一次拖多张只报一句，不挑一张偷偷传', async () => {
  const f = fixture();
  await f.controller.drop(transfer(png(), png()));
  assert.equal(f.state?.phase, 'error');
  assert.equal(f.uploads, 0);
  f.controller.dispose();
});

test('太大的图在上传之前就被挡下来', async () => {
  const f = fixture();
  await f.controller.drop(transfer(png(10 * 1024 * 1024 + 1)));
  assert.equal(f.state?.phase, 'error');
  assert.equal(f.uploads, 0, '别让一张 10MB 以上的图先跑一趟网络再被拒');
  f.controller.dispose();
});

/* 正在传的那一张不能被后来的顶掉——界面上它还挂着，用户以为还在传。 */
test('上传进行中时，再拖一张不打断前一张', async () => {
  const f = fixture();
  const first = f.controller.drop(transfer(png()));
  await f.controller.drop(transfer(png()));
  assert.equal(f.uploads, 1);
  f.reply();
  await first;
  f.controller.dispose();
});
