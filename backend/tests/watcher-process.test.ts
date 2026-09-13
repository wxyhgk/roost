import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedFileWatcher } from '../src/watcher-process';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(check: () => boolean) {
  for (let i=0;i<100;i++) { if(check()) return; await sleep(30); }
  throw new Error('watcher did not respond');
}
test('isolated watcher shares roots, reports real changes and releases its last subscription', async t => {
  const root=await mkdtemp(join(tmpdir(),'isolated-watch-'));const watcher=createIsolatedFileWatcher();
  t.after(async()=>{watcher.dispose();await rm(root,{recursive:true,force:true});});
  let first=0,second=0,errors=0;
  const closeFirst=watcher.watch(root,()=>first++,()=>errors++),closeSecond=watcher.watch(root,()=>second++,()=>errors++);
  await until(()=>first>0&&second>0);assert.equal(watcher.size,1);
  closeFirst();const before=second;await writeFile(join(root,'new.txt'),'change');await until(()=>second>before);
  assert.equal(errors,0);closeSecond();assert.equal(watcher.size,0);
  assert.throws(()=>watcher.watch(join(root,'missing'),()=>{}));
});
test('a blocked native watcher cannot stall the parent; watchdog fails subscriptions and disposal cancels recovery', async t => {
  const root=await mkdtemp(join(tmpdir(),'blocked-watch-'));
  const watcher=createIsolatedFileWatcher({entry:new URL('./fixtures/watcher-blocked.mjs',import.meta.url),heartbeatTimeout:300});
  let ticks=0,errors=0;const timer=setInterval(()=>ticks++,20);
  t.after(async()=>{clearInterval(timer);watcher.dispose();await rm(root,{recursive:true,force:true});});
  watcher.watch(root,()=>assert.fail('blocked watcher must not publish'),()=>errors++);
  await until(()=>errors===1);assert.ok(ticks>=5);assert.equal(watcher.size,0);
  watcher.dispose();assert.throws(()=>watcher.watch(root,()=>{}),/disposed/);
});
