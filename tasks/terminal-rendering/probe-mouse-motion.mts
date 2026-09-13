/**
 * 全屏渲染器会开 `?1003h`（上报所有鼠标移动）。光标划过终端会不会造成持续回流？
 *
 * 这是个需要排除的假设：如果每个 move 都触发重画，那「不滚动只是移鼠标」就已经在
 * 打满链路，和滚动快慢无关。实测是不会——CLI 只在 hover 命中变化时才重画。
 *
 * 注意方向：上行仍然是每次移动一条转义序列。本机可以忽略，弱网下是另一回事。
 *
 * 用法：
 *   node --import tsx tasks/terminal-rendering/probe-mouse-motion.mts
 */
import { startCli, sleep } from './probe-cli-harness.mts';

const cli = startCli({ renderer: 'fullscreen' });
await cli.prepare('seq 1 500');

console.log(
  `\n启用的鼠标模式: ?1000h=${cli.count('[?1000h')} ?1002h=${cli.count('[?1002h')}` +
  ` ?1003h=${cli.count('[?1003h')} ?1006h=${cli.count('[?1006h')}`,
);

const idle = await cli.sample(2000);
console.log(`静止 2s               : ${idle.bytes}B / ${idle.chunks} chunk`);

// 1 秒内从左上划到右下，约 60 个移动事件
const sweeping = cli.sample(2500);
for (let i = 0; i < 60; i++) {
  cli.move(5 + Math.round((i / 59) * (cli.cols - 10)), 3 + Math.round((i / 59) * (cli.rows - 6)));
  await sleep(16);
}
const sweep = await sweeping;
console.log(`划过整屏 60 个移动事件 : ${sweep.bytes}B / ${sweep.chunks} chunk`);

// 只在输入框一带抖动，看局部 hover 是否也触发
const jittering = cli.sample(2500);
for (let i = 0; i < 60; i++) { cli.move(20 + (i % 5), cli.rows - 3); await sleep(16); }
const jitter = await jittering;
console.log(`输入框附近抖动 60 次   : ${jitter.bytes}B / ${jitter.chunks} chunk`);

cli.stop();
process.exit(0);
