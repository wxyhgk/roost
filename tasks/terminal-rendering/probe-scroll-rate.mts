/**
 * 一格滚轮，TUI 实际滚几行？
 *
 * 用 `seq` 的行号当标尺：读 headless 缓冲区里可见的最小行号，发 n 格滚轮，再读一次。
 * 差值就是真实滚动距离——比数字节可靠，字节数只说明重画了多少，不说明视口走了多远。
 *
 * 用法：
 *   node --import tsx tasks/terminal-rendering/probe-scroll-rate.mts [SCROLL_SPEED]
 */
import { startCli, sleep } from './probe-cli-harness.mts';

const speed = process.argv[2];
const cli = startCli({ renderer: 'fullscreen', env: speed ? { CLAUDE_CODE_SCROLL_SPEED: speed } : {} });

await cli.prepare();

console.log(`\n== fullscreen${speed ? `  CLAUDE_CODE_SCROLL_SPEED=${speed}` : '  (未设 SCROLL_SPEED)'} ==`);
console.log(`缓冲区 = ${cli.term.buffer.active.type}，静止时可见最小行号 = ${cli.topNumber()}`);

for (const notches of [1, 1, 1, 3, 10, 30]) {
  const before = cli.topNumber();
  const bytesBefore = cli.bytes;
  cli.wheel('up', notches);
  await sleep(1500);
  const after = cli.topNumber();
  const moved = before !== null && after !== null ? before - after : null;
  console.log(
    `滚轮 ${String(notches).padStart(2)} 格 -> 顶行 ${before} → ${after}` +
    `   移动 ${String(moved).padStart(3)} 行` +
    `   ${moved !== null ? (moved / notches).toFixed(2) : '?'} 行/格` +
    `   回传 ${cli.bytes - bytesBefore}B`,
  );
}

cli.stop();
process.exit(0);
