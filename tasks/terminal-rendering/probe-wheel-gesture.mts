/**
 * 一次真实手势，前端最终发出几格？
 *
 * 直接调用产品代码里的 `wheelTicks`，不重写一份——重写就只是在测这个脚本自己。
 * 纯计算，不起 CLI、不连任何东西。
 *
 * 「Claude 滚几行」按 probe-scroll-rate.mts 实测的 1 行/格换算（未设 SCROLL_SPEED
 * 且终端未被识别时的默认）。慢手势没有加速，快甩会更高一些，所以这里是下界。
 *
 * 用法：
 *   node --import tsx tasks/terminal-rendering/probe-wheel-gesture.mts        # 现在的行为
 *   node --import tsx tasks/terminal-rendering/probe-wheel-gesture.mts damp   # 旧行为（打 0.3 阻尼）
 */
import { wheelTicks } from '../../frontend/src/features/terminal/wheel.ts';

const CELL = 17;                                   // 典型行高 px
const DAMP = process.argv[2] === 'damp';           // 转发路径现在传 false，这里复现两种

/** macOS 触控板一次滑动：像素事件，deltaY 先升后降。 */
function trackpad(totalPx: number, events: number) {
  const shape = Array.from({ length: events }, (_, i) => Math.sin((Math.PI * (i + 0.5)) / events));
  const sum = shape.reduce((a, b) => a + b, 0);
  return shape.map(w => (w / sum) * totalPx);
}
/** 传统鼠标滚轮：每格约 100px，Chrome 也按像素上报。 */
const mouse = (notches: number) => Array.from({ length: notches }, () => 100);

function run(name: string, deltas: number[]) {
  let carry = 0;
  let ticks = 0;
  for (const deltaY of deltas) {
    const result = wheelTicks({ deltaY, deltaMode: 0 } as WheelEvent, CELL, carry, DAMP);
    carry = result.carry;
    ticks += Math.abs(result.ticks);
  }
  const totalPx = deltas.reduce((sum, d) => sum + Math.abs(d), 0);
  const native = totalPx / CELL;
  console.log(
    `${name.padEnd(26)} 位移 ${String(Math.round(totalPx)).padStart(4)}px` +
    ` = 原生 ${native.toFixed(1).padStart(5)} 行  →  发出 ${String(ticks).padStart(3)} 格` +
    ` → TUI 滚 ${String(ticks).padStart(3)} 行  (${((ticks / native) * 100).toFixed(0)}% of 原生)`,
  );
}

console.log(`\n== wheelTicks damp=${DAMP} + TUI 1 行/格 ==\n`);
run('触控板 轻扫 420px/26事件', trackpad(420, 26));
run('触控板 大力扫 1200px/40', trackpad(1200, 40));
run('触控板 慢推 150px/30', trackpad(150, 30));
run('鼠标滚轮 3 格', mouse(3));
run('鼠标滚轮 10 格', mouse(10));
console.log('\n阻尼只命中 |deltaY| < 50 的事件，所以整格鼠标滚轮两种模式一样，触控板差三倍多。');
