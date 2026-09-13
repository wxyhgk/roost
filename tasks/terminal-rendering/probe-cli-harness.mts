/**
 * 共用台架：真实 CLI ↔ node-pty ↔ @xterm/headless。
 *
 * 用 headless 当「终端」而不是自己伪造应答，是因为**能力探测的答案决定 CLI 发什么**。
 * Claude Code 会问 DA1、XTVERSION、OSC 11、kitty 键盘协议；答不答、答什么，直接决定
 * 它开不开同步输出、走不走增量重绘。手写应答只会测到我们以为的终端，测不到前端真正
 * 表现出的那一个——前端用的就是这同一个解析器。
 *
 * 只读性质：每次在独立临时目录里起一个新会话，不碰用户的工作区数据库、不连守护进程、
 * 不 resume 任何已有会话。内容一律用 `!` 的本地 shell 命令生成，不发模型请求。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import headless from '@xterm/headless';

const { Terminal } = headless;
export const ESC = String.fromCharCode(27);
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export type Renderer = 'fullscreen' | 'classic';

export interface HarnessOptions {
  renderer?: Renderer;
  cols?: number;
  rows?: number;
  /** 冒充哪个终端回答 XTVERSION。不给就不回答——这正是前端 xterm.js 现在的行为。 */
  xtversion?: string;
  /** 传给 CLI 的额外环境变量，例如 CLAUDE_CODE_SCROLL_SPEED。 */
  env?: Record<string, string>;
}

export function startCli(options: HarnessOptions = {}) {
  const { renderer = 'fullscreen', cols = 146, rows = 46, xtversion } = options;
  const work = mkdtempSync(join(tmpdir(), 'probe-cli-'));

  // 清掉继承来的 CLAUDE*：这个进程很可能本身就跑在 Claude Code 里，
  // 带着父会话的 socket、token 和 OBSERVING 标记去起子会话会测到别的东西。
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('CLAUDE')) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (renderer === 'fullscreen') env.CLAUDE_CODE_NO_FLICKER = '1';
  else env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';
  Object.assign(env, options.env ?? {});

  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  const child = pty.spawn('claude', [], { name: 'xterm-256color', cols, rows, cwd: work, env });

  let all = '';
  let bytes = 0;
  const chunks: { t: number; off: number; len: number }[] = [];
  const started = Date.now();
  /** 当前采样窗口；null 表示不在采样。 */
  let window: { t: number; len: number }[] | null = null;

  // 前端 → CLI：xterm.js 自己生成的能力应答，一个字都不改。
  term.onData(data => child.write(data));

  child.onData(data => {
    all += data;
    bytes += Buffer.byteLength(data);
    chunks.push({ t: Date.now() - started, off: bytes, len: Buffer.byteLength(data) });
    window?.push({ t: Date.now() - started, len: Buffer.byteLength(data) });
    term.write(data);
    if (!xtversion) return;
    // 只有显式要求时才冒充终端；OSC 11 一并回答，否则 CLI 还在等颜色。
    if (data.includes(`${ESC}[>0q`)) child.write(`${ESC}P>|${xtversion}${ESC}\\`);
    if (data.includes(`${ESC}]11;?`)) child.write(`${ESC}]11;rgb:1e1e/1e1e/1e1e${ESC}\\`);
  });

  const count = (tail: string) => {
    let found = 0;
    let index = 0;
    const needle = ESC + tail;
    while ((index = all.indexOf(needle, index)) >= 0) { found++; index += needle.length; }
    return found;
  };

  return {
    term,
    cols,
    rows,
    get bytes() { return bytes; },
    get output() { return all; },
    chunks,
    /** 数一个 CSI 序列出现了几次，参数写成 `[?2026h` 这样的尾巴。 */
    count,
    write: (data: string) => child.write(data),
    /** SGR 1006 的滚轮上报，n 格。 */
    wheel(direction: 'up' | 'down', n: number, col = 70, row = 20) {
      child.write(`${ESC}[<${direction === 'up' ? 64 : 65};${col};${row}M`.repeat(n));
    },
    /** SGR 1006 的无按键移动上报。 */
    move(col: number, row: number) { child.write(`${ESC}[<35;${col};${row}M`); },
    /** 采样一段时间内 CLI 回传了什么。 */
    async sample(ms: number) {
      window = [];
      await sleep(ms);
      const taken = window;
      window = null;
      return { chunks: taken.length, bytes: taken.reduce((sum, c) => sum + c.len, 0) };
    },
    /** 过信任目录对话框，再用 `!` 跑一条本地命令把屏幕填满。 */
    async prepare(fill = 'seq 1 2000') {
      await sleep(3000);
      child.write(`${ESC}[B`);          // 高亮默认停在「No, exit」，先下移一格
      await sleep(400);
      child.write('\r');
      await sleep(5000);
      child.write('!');                 // 进 bash 模式，不产生模型请求
      await sleep(500);
      child.write(fill);
      await sleep(700);
      child.write('\r');
      await sleep(9000);
    },
    /** 可见区里所有「整行只有一个数字」的行号，配合 `seq` 当滚动标尺用。 */
    visibleNumbers() {
      const buffer = term.buffer.active;
      const numbers: number[] = [];
      for (let row = 0; row < rows; row++) {
        const text = buffer.getLine(buffer.viewportY + row)?.translateToString(true).trim();
        if (text && /^\d+$/.test(text)) numbers.push(Number(text));
      }
      return numbers;
    },
    topNumber() {
      const numbers = this.visibleNumbers();
      return numbers.length ? Math.min(...numbers) : null;
    },
    stop() {
      child.kill();
      rmSync(work, { recursive: true, force: true });
    },
  };
}
