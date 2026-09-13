/**
 * 同步输出（DEC 2026）在什么条件下才会被启用？
 *
 * 因果测试：唯一的变量是「回不回答 XTVERSION（`CSI >0q`）」，其余完全一致。
 * xterm.js 只回一个 DA1 `CSI ?1;2c`，不答 XTVERSION —— 于是 CLI 把它当未知终端，
 * 连 `CSI ?2026$p` 的支持性探测都不发，整条链路上没有一个 BSU/ESU。
 *
 * 同时量「一次滚动会被提交几次绘制」：没有 2026 时每个 chunk 就是一次部分绘制，
 * 有 2026 时只有 ESU 才提交一次。
 *
 * 用法：
 *   node --import tsx tasks/terminal-rendering/probe-sync-output.mts            # 现状
 *   node --import tsx tasks/terminal-rendering/probe-sync-output.mts "ghostty 1.2.0"
 *   node --import tsx tasks/terminal-rendering/probe-sync-output.mts "roost-ai-coding-web 1.0"
 */
import { startCli, ESC, sleep } from './probe-cli-harness.mts';

const xtversion = process.argv[2];
const cli = startCli({ renderer: 'fullscreen', xtversion });

await cli.prepare('seq 1 800');

console.log(`\n== XTVERSION 应答 = ${xtversion ?? '(不回答，即前端 xterm.js 的现状)'} ==`);
console.log(`  ?2026$p 支持性探测 : ${cli.count('[?2026$p')}`);
console.log(`  ?2026h (BSU)      : ${cli.count('[?2026h')}`);
console.log(`  ?1049h (备用屏)    : ${cli.count('[?1049h')}`);
console.log(`  ?1006h (SGR 鼠标)  : ${cli.count('[?1006h')}`);

for (const notches of [1, 5, 15]) {
  const before = cli.output.length;
  cli.wheel('up', notches);
  const sample = await cli.sample(1800);
  const body = cli.output.slice(before);
  let bsu = 0;
  let index = 0;
  while ((index = body.indexOf(`${ESC}[?2026h`, index)) >= 0) { bsu++; index += 8; }
  // 没有 2026：每个 chunk 落地即绘制。有 2026：一个 BSU..ESU 才提交一次。
  console.log(
    `  滚轮 ${String(notches).padStart(2)} 格 -> ${String(sample.chunks).padStart(2)} 个 chunk` +
    ` / ${String(sample.bytes).padStart(5)}B / BSU=${bsu}` +
    `  => 前端提交绘制 ${bsu > 0 ? bsu : sample.chunks} 次`,
  );
  await sleep(200);
}

cli.stop();
process.exit(0);
