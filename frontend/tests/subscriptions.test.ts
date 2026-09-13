import assert from 'node:assert/strict';
import { test } from 'node:test';
import { primaryWindow, remainingPercent, type SubscriptionSnapshot } from '@roost/subscriptions';
import { createUsageFeed } from '../src/features/subscriptions/feed';
const tick=()=>new Promise<void>(r=>setImmediate(r));
const sample=(provider='opencode-go')=>({provider,state:'ready',windows:[{id:'monthly',usedPercent:94}],primaryWindowId:'monthly',observedAt:new Date().toISOString()} as SubscriptionSnapshot);
test('remaining quota preserves unknown values and the server-selected limiting window',()=>{
 assert.equal(remainingPercent(primaryWindow(sample())),6);assert.equal(remainingPercent(undefined),null);assert.equal(remainingPercent({usedPercent:105} as any),0);
});
test('readers share one request, hidden tabs stop polling and obsolete results cannot overwrite accepted data',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let visible=true,change=()=>{};const requests:{signal:AbortSignal;resolve(value:SubscriptionSnapshot):void}[]=[];
 const feed=createUsageFeed(signal=>new Promise(resolve=>requests.push({signal,resolve})),{visible:()=>visible,subscribe:(_wake,fn)=>{change=fn;return()=>{};}});
 const stopA=feed.subscribe(()=>{}),stopB=feed.subscribe(()=>{});await tick();assert.equal(requests.length,1);
 requests[0].resolve(sample());await tick();t.mock.timers.tick(60000);await tick();assert.equal(requests.length,2);
 visible=false;change();assert.equal(requests[1].signal.aborted,true);requests[1].resolve({...sample(),plan:'old'});await tick();assert.equal(feed.getSnapshot().snapshot?.plan,undefined);
 t.mock.timers.tick(300000);await tick();assert.equal(requests.length,2);visible=true;change();await tick();assert.equal(requests.length,3);
 feed.accept({...sample(),plan:'new'});requests[2].resolve({...sample(),plan:'old'});await tick();assert.equal(feed.getSnapshot().snapshot?.plan,'new');stopA();stopB();
});
test('network failure retains the previous reading and backs off instead of polling repeatedly',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const feed=createUsageFeed(async()=>{if(++calls>1)throw Error('offline');return sample();},{visible:()=>true,subscribe:()=>()=>{}});
 const stop=feed.subscribe(()=>{});await tick();t.mock.timers.tick(60000);await tick();assert.equal(feed.getSnapshot().failed,true);assert.equal(feed.getSnapshot().snapshot?.observedAt!=null,true);
 t.mock.timers.tick(29999);await tick();assert.equal(calls,2);t.mock.timers.tick(1);await tick();assert.equal(calls,3);stop();
});
