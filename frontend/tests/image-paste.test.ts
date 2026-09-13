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
