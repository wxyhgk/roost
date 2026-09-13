import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServerMonitorProcess } from '../src/collector-client.ts';
async function recovered(m: ReturnType<typeof createServerMonitorProcess>) {
 for(let i=0;i<40;i++) { try { return await m.snapshot(); } catch { await new Promise(r=>setTimeout(r,25)); } }
 throw new Error('collector did not recover');
}
const collectorUrl = new URL('./fixtures/collector.mjs', import.meta.url);
/*
  这里配置的服务名一律**自带 .service 后缀**：两套规范化规则对它都是恒等
  （systemd 不会重复补，launchd 原样接受），所以断言在 Linux 和 macOS 上一样成立。
  这几个用例测的是取数进程的生命周期——并发合并、崩溃恢复、配置切换、超时换进程
  ——不是名字规则；规则本身由 monitor.test.ts 和 launchd.test.ts 分别钉着。

  写裸名字会在 macOS 上挂：collector-client 按平台分派规范化，launchd 那边不补后缀，
  而 fixture 是照 'slow.service' / 'crash.service' 这些判定行为的。
*/
test('summary RPC coalesces its readers without requesting a full snapshot', async t => {
 const m=createServerMonitorProcess({collectorUrl});t.after(m.dispose);
 const a=m.summary();assert.equal(a,m.summary());const result=await a as unknown as {kind:string;reads:number};
 assert.equal(result.kind,'summary');assert.equal(result.reads,1);
 assert.equal((await m.snapshot() as unknown as {kind:string}).kind,'snapshot');
});
test('a synchronous collector leaves the parent responsive and concurrent readers share one snapshot', async t => {
 const m=createServerMonitorProcess({collectorUrl});t.after(m.dispose);m.configure(['slow.service']);
 const a=m.snapshot(),b=m.snapshot();assert.equal(a,b);
 let ticks=0;const timer=setInterval(()=>ticks++,20);t.after(()=>clearInterval(timer));
 const s=await a;assert.ok(ticks>=5);assert.deepEqual(s.configuredServices,['slow.service']);assert.equal((s as unknown as {reads:number}).reads,1);
});
test('a crashed collector can recover', async t => {
 const m=createServerMonitorProcess({collectorUrl,retryAfter:0});t.after(m.dispose);
 await m.snapshot();m.configure(['crash.service']);await assert.rejects(m.snapshot(),/unavailable/);
 m.configure(['caddy.service']);assert.deepEqual((await recovered(m)).configuredServices,['caddy.service']);
 m.dispose();await assert.rejects(m.snapshot(),/closed/);
});
test('configuration changes during a request get a distinct snapshot with the new units', async t => {
 const m=createServerMonitorProcess({collectorUrl});t.after(m.dispose);
 m.configure(['delayed.service']);const old=m.snapshot();m.configure(['caddy.service']);const next=m.snapshot();
 assert.notEqual(old,next);
 assert.deepEqual((await old).configuredServices,['delayed.service']);
 assert.deepEqual((await next).configuredServices,['caddy.service']);
});
test('deadline terminates a stuck collector and subsequent reads use a fresh process', async t => {
 const m=createServerMonitorProcess({collectorUrl,timeout:150,retryAfter:0});t.after(m.dispose);
 m.configure(['slow.service']);await assert.rejects(m.snapshot(),/unavailable/);
 m.configure(['caddy.service']);assert.deepEqual((await recovered(m)).configuredServices,['caddy.service']);
});
