/*
  加速渲染器的持有策略。

  这个模块存在的唯一理由是**别把上下文攥在手里**：浏览器同时能给的 WebGL 上下文是个很小的
  死数字，超了会悄悄弄坏最老的那个。roost 每个打开的会话都常驻一个 xterm 实例（实测同时
  挂着 9 个），所以「谁持有」这件事必须是确定的，不能靠时序碰运气。

  下面每条用例盯的都是一种「会多攥一个」或「会一直攥着」的走法。
*/
import { equal, match, ok } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAccelerator } from '../src/features/terminal/engine/accel.ts';

/*
  假 addon：只实现 `createAccelerator` 真正用到的那三个方法。真的 WebglAddon 在 Node 里
  构造不出来，而这个模块要测的「谁持有、持有几个」是纯时序逻辑，和 GPU 无关。
*/
function fake() {
  const made: { disposed: boolean; lose: () => void }[] = [];
  const term = { loadAddon(addon: any) { attached.push(addon); } } as any;
  const attached: any[] = [];
  const load = async () => {
    let onLoss = () => {};
    const addon: any = {
      disposed: false,
      activate() {},
      dispose() { addon.disposed = true; },
      onContextLoss(cb: () => void) { onLoss = cb; },
      lose: () => onLoss(),
    };
    made.push(addon);
    return addon;
  };
  return { term, load, made, attached, live: () => made.filter(a => !a.disposed).length };
}

/** 等注入的 load() 那条 then 链跑完。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('后台不申请：只有告诉它是前台才会去拿上下文', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => true, f.load);
  a.set(false);
  await settle();
  equal(f.made.length, 0, '后台的终端一个上下文都不该申请');
  equal(a.state, 'off');
});

test('开关关掉时，连前台也不申请', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => false, f.load);
  a.set(true);
  await settle();
  equal(f.made.length, 0);
  equal(a.state, 'off');
});

test('切到后台必须把上下文还回去——攥着不放正是要避免的那件事', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => true, f.load);
  a.set(true);
  await settle();
  equal(a.state, 'on');
  equal(f.live(), 1);
  a.set(false);
  equal(f.live(), 0, '切到后台之后还攥着上下文');
  equal(a.state, 'off');
});

test('反复前后台切换不会攒出第二个上下文', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => true, f.load);
  for (let i = 0; i < 5; i++) { a.set(true); await settle(); a.set(false); }
  equal(f.live(), 0);
  ok(f.made.length <= 5, '每轮最多申请一次');
  a.set(true); await settle();
  equal(f.live(), 1, '任何时刻最多一个');
});

test('已经是前台时重复调用不重复申请', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => true, f.load);
  a.set(true); await settle();
  const first = f.made.length;
  a.set(true); a.set(true); await settle();
  equal(f.made.length, first, '重复的前台通知不该再申请一个');
});

test('异步取回来之前就切走了，这一次的结果作废', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => true, f.load);
  a.set(true);
  a.set(false);   // import 还没回来
  await settle();
  equal(f.live(), 0, '回来的时候已经不是前台了，不该挂上去');
});

test('dispose 之后不再持有，连取都不去取', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => true, f.load);
  a.set(true); await settle();
  a.dispose();
  equal(f.live(), 0);
  const before = f.made.length;
  a.set(true); await settle();
  equal(f.live(), 0, 'dispose 之后还能被唤醒就等于泄漏');
  // 光看「没持有」分不出两种实现：一种压根不去取，一种取回来再扔掉。后者会在已经拆掉的
  // 终端上白跑一次动态 import，所以这里要的是**连取都不取**。
  equal(f.made.length, before, 'dispose 之后不该再去取 addon');
});

test('上下文被浏览器收走之后要松手，回前台再试一次', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => true, f.load);
  a.set(true); await settle();
  equal(a.state, 'on');
  f.made[0]!.lose();                       // 浏览器把它收走了
  equal(f.live(), 0, '丢了之后必须 dispose，不能留着一个坏的');
  equal(a.state, 'off', '要回到可以再试的状态');
  a.set(false); a.set(true); await settle();
  equal(a.state, 'on', '下一次回到前台应当再申请一次——驱动重置、休眠唤醒都会丢，值得重试');
});

test('反复被收走就认命，不再申请——否则每次切前台都在挤别人的上下文', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => true, f.load);
  for (let i = 0; i < 6; i++) {
    a.set(true); await settle();
    const live = f.made.find(x => !x.disposed);
    if (live) live.lose();
    a.set(false);
  }
  equal(a.state, 'unavailable');
  const before = f.made.length;
  a.set(true); await settle();
  equal(f.made.length, before, '认命之后不该再申请');
  equal(f.live(), 0);
  ok(before <= 3, `最多试到第 ${before} 次就该停，实际试了 ${before} 次`);
});

test('取不到 addon（没有 WebGL、被禁用、驱动黑名单）时安静留在 DOM 渲染器上', async () => {
  const f = fake();
  const a = createAccelerator(f.term, () => true, async () => { throw new Error('no webgl'); });
  a.set(true); await settle();
  equal(a.state, 'unavailable');
  a.set(true); await settle();
  equal(a.state, 'unavailable', '取不到就别反复试——这不是错误，是这台机器的事实');
  equal(f.attached.length, 0);
});

/*
  ——— 接线 ———

  上面测的是策略。但策略对了不等于线接上了：`createAccelerator` 造出来却没人告诉它前后台，
  表现就是「所有终端都不加速」或者「所有终端都攥着上下文」，而上面十条一条都发现不了。
  这正是这个会话里 agent_peers 栽过的那一跤，所以这里把接线也钉住。

  扫源码而不是渲染结果：要挡的就是「有人把那一行删了」。
*/
const code = (path: string) => readFileSync(new URL(path, import.meta.url).pathname, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

test('前后台切换必须通知加速器，否则后台的终端会一直攥着上下文', () => {
  const controller = code('../src/features/terminal/session/sessionController.ts');
  const setActive = controller.slice(controller.indexOf('setActive(value: boolean)'));
  match(setActive.slice(0, 400), /setAccelerated\?\.\(value\)/,
    'setActive 里没有通知加速器：切到后台之后上下文还攥着，开到第 17 个终端就会有人被悄悄弄坏');
  match(controller, /term\.setAccelerated\?\.\(active\)/,
    '引擎刚就绪时也要给一次——前台身份是引擎出生之前就定下的');
});

test('引擎销毁时要连加速器一起销毁', () => {
  const engine = code('../src/features/terminal/engine/xtermEngine.ts');
  match(engine, /accel\.dispose\(\)/, '终端拆了却不还上下文，就是纯泄漏');
  match(engine, /createAccelerator\(/, '引擎里应当还持有一个加速器');
});
