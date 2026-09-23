import type { ScreenView } from '@roost/terminal-runtime';
import { MAX_DIRECT_INPUT_BYTES, type DirectInputHold, type DirectInputResult } from '@roost/terminal-protocol';

/*
  从网页往终端里的 CLI 直接打一句话：贴进去、看见它、按回车。

  **为什么推倒 ai-command-owner 那条路。** 那条路要先证明万无一失才按回车：画面必须被
  白名单**完整认出**、身份链（对话→运行→绑定→原生会话→终端实例→代次）每一环都对得上、
  前面没有悬而未决的命令。每一条单看都有道理，叠起来几乎不可能同时成立——claude 一干活
  光标就离开输入框，画面「认不出」；daemon 一重启、claude 一换会话，身份链就断；一条没等
  到回执的消息会把后面所有消息挡死。上线以来零次成功投递。

  这里换成 VS Code `sendText`、tmux `send-keys` 的模型：**终端是主角，网页只是输入框。**
  写给哪个终端就是哪个终端，不核对它「是哪个对话」。CLI 忙的时候不等——claude 和 omp 都会
  自己把干活时收到的输入排队（omp 在 2026-09-23 摸底实测过：进 `Steering` 队列，这一轮
  做完再处理）。每一句的结果只说这一句，从不影响下一句。

  **只留一道闸：画面底部是选择框时不按回车。** `\r` 是一个没有寻址的字节，落在权限框上
  就是「批准」，落在 codex 的更新菜单上就是执行 `curl … | sh`（摸底时的真实画面，见
  tests/fixtures/screens/）。这道闸挡的就是这一种。

  代价明说：碰上一个没收录的新对话框，回车可能落错地方。换来的是这件事第一次真的能用。
*/

/** 通栏横线：claude 画 `─`，omp 在 ASCII 模式下画 `-`。 */
const RULE = /^\s*[-─━]{20,}\s*$/;

/** 只看底部这么多行。上面是对话正文——正文里完全可能出现「Do you want to proceed」这种字样。 */
const DIALOG_WINDOW = 12;

/*
  「这是一个等你选的框」的措辞。来源：claude-screen.ts 里积累的那份（claude 的权限框、
  信任目录框），加上 2026-09-23 摸底录到的 omp 权限框（`Allow tool:` / `enter select`）和
  codex 启动时的两个菜单（`Press enter to continue`）。
*/
const DIALOG_PHRASES = /Do you trust|trust this folder|Yes,? (?:allow|I trust)|Allow (?:once|always)|Allow tool:|Do you want to proceed|Choose an option|Enter to (?:select|confirm|continue)|enter select|Press enter to|Esc to cancel|\((?:y\/n|Y\/n|y\/N)\)|\[(?:y\/n|Y\/n|y\/N)\]/i;

/** 高亮着的编号选项，而且下一行还是一个编号选项——一个真正的菜单，不是用户恰好写了「1.」。 */
const HIGHLIGHTED_OPTION = /^\s*[›>❯]\s*\d+\.\s/;
const PLAIN_OPTION = /^\s+\d+\.\s/;

export const lines = (view: ScreenView) => view.rows.map(row => row.text);

/**
 * 这个 CLI 的输入框此刻在不在画面上。
 *
 * - `true`  认得这个 CLI，输入框在。
 * - `false` 认得这个 CLI，输入框不在——它的对话框会**顶替**输入框，所以不在就是有情况。
 * - `null`  不知道这个 CLI 的输入框长什么样，只能靠措辞判断。
 *
 * **不看光标。** 旧的判据要求光标正好停在 `❯` 那一行，而 claude 干活时光标会离开输入框，
 * 于是它一忙就「认不出」，一个字都不写。输入框本身一直画着，看它就够了。
 */
export function inputBox(cli: string, rows: string[]): boolean | null {
  const bottom = Math.max(0, rows.length - 16);
  if (cli === 'claude') {
    // ─── / ❯ 正文（可能多行）/ ───。上边那条紧贴着 ❯，下边那条在十行之内。
    for (let i = rows.length - 1; i > bottom; i--) {
      if (!/^\s*❯(?:\s|$)/.test(rows[i]) || !RULE.test(rows[i - 1] ?? '')) continue;
      for (let j = i + 1; j <= Math.min(rows.length - 1, i + 10); j++) if (RULE.test(rows[j])) return true;
    }
    return false;
  }
  if (cli === 'omp') {
    /*
      最底下是状态栏，它上面两条通栏横线夹着输入行。更新提示那种横幅也用同样的横线，
      所以取**最靠底**的一对。权限框画的是 `+---+` 盒子，不是通栏横线，于是它顶掉输入框
      之后底部就找不到这一对了——实测画面见 tests/fixtures/screens/omp-approval.txt。
    */
    const last = rows.length - 1 - rows.slice().reverse().findIndex(row => row.trim() !== '');
    for (let lower = last; lower >= Math.max(0, last - 3); lower--) {
      if (!RULE.test(rows[lower])) continue;
      for (let upper = lower - 2; upper >= Math.max(0, lower - 12); upper--) if (RULE.test(rows[upper])) return true;
      return false;
    }
    return false;
  }
  return null;
}

/** 底部是不是一个等你选的框。 */
export function dialogOnScreen(rows: string[]): boolean {
  /*
    「底部」是**内容的**底部，不是屏幕的。codex 启动时的菜单只画了前 15 行、下面整整二十行
    空着（摸底录到的真实画面）——按屏幕取最底下 12 行，拿到的全是空行，菜单就漏过去了。
  */
  let end = rows.length;
  while (end > 0 && rows[end - 1].trim() === '') end--;
  const tail = rows.slice(Math.max(0, end - DIALOG_WINDOW), end);
  if (tail.some(row => DIALOG_PHRASES.test(row))) return true;
  return tail.some((row, i) => HIGHLIGHTED_OPTION.test(row) && (PLAIN_OPTION.test(tail[i + 1] ?? '') || PLAIN_OPTION.test(tail[i + 2] ?? '')));
}

/** 现在按回车安不安全。认得输入框就以它为准；认不得就看有没有对话框的措辞。 */
export function assess(cli: string, rows: string[]): { ok: true } | { ok: false; reason: DirectInputHold } {
  const box = inputBox(cli, rows);
  if (box === true) return { ok: true };
  if (dialogOnScreen(rows)) return { ok: false, reason: 'dialog' };
  if (box === false) return { ok: false, reason: 'no_input_box' };
  return { ok: true };
}

/** 整屏拼成一段：终端自己折的行接回去，空白一律压成一个空格。 */
export function screenText(view: ScreenView): string {
  let out = '';
  for (const row of view.rows) out += (row.wrapped ? '' : '\n') + row.text;
  return out.replace(/\s+/g, ' ');
}

/**
 * 拿来认「贴进去的字出现了」的那一小段：第一行的前 12 个字。
 *
 * 只取开头一小段，是因为 TUI 会自己折行（claude 在输入框里按宽度断开，断点可能落在词中间），
 * 取长了就会被折断而认不出。12 个汉字是 24 列，任何正常宽度的输入框第一行都放得下。
 */
export function fragment(text: string): string {
  const first = text.split('\n').find(line => line.trim() !== '') ?? '';
  return [...first.replace(/\s+/g, ' ').trim()].slice(0, 12).join('');
}

const count = (haystack: string, needle: string) => {
  if (!needle) return 0;
  let n = 0, at = haystack.indexOf(needle);
  while (at >= 0) { n++; at = haystack.indexOf(needle, at + needle.length); }
  return n;
};

/**
 * 贴进去之后，画面上**多出了**这段字——比贴之前多，而不是「有」。
 *
 * 比数量而不是找有没有：历史里可能正好留着同样的原文（omp 实测，上一条 prompt 就在屏幕
 * 上方），光找「有」会被它骗过去。多行或很长的内容会被 claude 折成 `[Pasted text #1 +4 lines]`，
 * 那个标记多了一个也算。
 */
export function echoSeen(before: string, after: string, frag: string): boolean {
  return count(after, frag) > count(before, frag) || count(after, '[Pasted text') > count(before, '[Pasted text');
}

/**
 * 进来的正文先洗一遍。
 *
 * **控制字符必须去掉，这不是洁癖。** 正文是包在 bracketed paste 里写进去的，正文里要是
 * 夹着一个 `ESC[201~`，粘贴就在那儿提前结束，后面的字节会被当成**按键**——包括回车。
 * 换行和制表符留着，它们在粘贴里就是字面意思。
 */
export function normalize(text: unknown): string {
  if (typeof text !== 'string') throw Object.assign(new Error('text required'), { status: 400, code: 'invalid_request' });
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\s+$/, '');
  if (!clean.trim()) throw Object.assign(new Error('text required'), { status: 400, code: 'invalid_request' });
  if (Buffer.byteLength(clean) > MAX_DIRECT_INPUT_BYTES) throw Object.assign(new Error('text too large'), { status: 413, code: 'too_large' });
  return clean;
}

export type DirectInputOptions = {
  session(id: string): { instanceId: string } | undefined;
  view(id: string): ScreenView | null;
  write(id: string, data: string): void;
  /** 三态：CLI 名 / null（确定不是 CLI）/ undefined（判断不了）。 */
  foreground(id: string): Promise<string | null | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 等回显最多多久。旧路是 2 秒，实测曾经差一点——claude 处理粘贴本身要时间。 */
  echoTimeoutMs?: number;
  pollMs?: number;
  /** 看见回显之后再等一下才按回车：TUI 刚收完粘贴，给它把这一帧处理完。 */
  settleMs?: number;
};

export function createDirectInput(options: DirectInputOptions) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const echoTimeout = options.echoTimeoutMs ?? 3000, poll = options.pollMs ?? 50, settle = options.settleMs ?? 120;
  /** 同一个终端一次只打一句：两句的「贴」和「回车」交错起来，就是把两句拼成一句发出去。 */
  const chains = new Map<string, Promise<unknown>>();

  async function once(id: string, text: string): Promise<DirectInputResult> {
    const start = options.session(id);
    if (!start) throw Object.assign(new Error('terminal not found'), { status: 404, code: 'not_found' });
    const same = () => options.session(id)?.instanceId === start.instanceId;
    const cli = await options.foreground(id);
    if (cli === undefined) return { status: 'held', reason: 'foreground_unknown', cli: null };
    // 前台是 shell：往里打字再回车就是执行一条命令。这个输入框是给 AI CLI 的。
    if (cli === null) return { status: 'held', reason: 'not_cli', cli: null };
    const first = options.view(id);
    if (!first || !same()) return { status: 'held', reason: 'screen_unavailable', cli };
    const gate = assess(cli, lines(first));
    if (!gate.ok) return { status: 'held', reason: gate.reason, cli };

    const frag = fragment(text), before = screenText(first);
    options.write(id, '\x1b[200~' + text + '\x1b[201~');

    // 没看见它出现就不按回车：粘贴可能被一个我们没认出来的框吞了（omp 的权限框就是这样，
    // 实测贴进去的字哪儿都不出现），这时回车只会落在那个框上。
    const deadline = now() + echoTimeout;
    let seen = false;
    while (now() < deadline) {
      await sleep(poll);
      const view = options.view(id);
      if (view && echoSeen(before, screenText(view), frag)) { seen = true; break; }
    }
    if (!seen || !same()) return { status: 'pasted', cli };

    await sleep(settle);
    // 贴完到回车之间画面可能又变了。最后看一眼：输入框还在、前台还是它、还是那个终端。
    const last = options.view(id);
    if (!last || !assess(cli, lines(last)).ok) return { status: 'pasted', cli };
    if (await options.foreground(id) !== cli || !same()) return { status: 'pasted', cli };
    options.write(id, '\r');
    return { status: 'submitted', cli };
  }

  return {
    type(id: string, raw: unknown): Promise<DirectInputResult> {
      let text: string;
      try { text = normalize(raw); } catch (error) { return Promise.reject(error); }
      const previous = chains.get(id) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => once(id, text));
      chains.set(id, next);
      void next.catch(() => undefined).finally(() => { if (chains.get(id) === next) chains.delete(id); });
      return next;
    },
  };
}

export type DirectInput = ReturnType<typeof createDirectInput>;
