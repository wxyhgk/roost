import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assess, createDirectInput, dialogOnScreen, echoSeen, fragment, inputBox, normalize, screenText } from '../src/direct-input.ts';
import type { ScreenView } from '@roost/terminal-runtime';

/*
  omp / codex 的画面是 2026-09-23 摸底时从真终端里录下来的（node-pty + headless xterm，
  120×36），不是手写的。claude 的是手写的形状——它的输入框判据在 claude-screen.ts 的测试里
  另有一份按版本实测的记录。
*/
const fixture = (name: string) => {
  const rows = readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8').split('\n');
  while (rows.length < 36) rows.push('');
  return rows.slice(0, 36);
};
const view = (rows: string[]): ScreenView => ({ rows: rows.map(text => ({ text, wrapped: false })), cursorX: 0, cursorY: 0 });

const rule = '─'.repeat(100);
const claude = (input = '', above: string[] = []) => [
  ...Array(20).fill(''), ...above, '⏺ 上一轮的回答', '', rule, `❯ ${input}`, rule, '  ⏵⏵ auto mode on · 1 shell',
];

test('认得 claude 的输入框，而且不看光标在哪', () => {
  assert.equal(inputBox('claude', claude()), true);
  // claude 干活时光标会离开输入框——旧判据因此一忙就「认不出」，一个字都不写。
  assert.equal(assess('claude', claude('', ['✻ Thinking… (esc to interrupt)'])).ok, true);
  assert.equal(inputBox('claude', claude('一段还没发的字')), true);
});

test('claude 的对话框顶替了输入框：不按回车', () => {
  const permission = [...Array(24).fill(''), ' Bash command', '   rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'];
  assert.equal(inputBox('claude', permission), false);
  assert.deepEqual(assess('claude', permission), { ok: false, reason: 'dialog' });
  // 没有输入框、也没有认得的措辞：认得这个 CLI，就知道「输入框不在」本身就是有情况。
  assert.deepEqual(assess('claude', [...Array(30).fill(''), ' 某个没见过的全屏界面']), { ok: false, reason: 'no_input_box' });
});

test('历史里你发过的「❯ …」加上权限框顶上那条线，不能拼成一个输入框', () => {
  // claude 把你以前发的话也画成「❯ 」开头；权限框顶上有一条通栏横线。只要求「下面有线」，
  // 这两样拼起来就像一个输入框——那时按回车就是替你点了「Yes」。所以 ❯ 正上方必须紧贴一条线。
  const screen = [...Array(18).fill(''), '❯ 跑一下测试', '', '⏺ 好的，先看看 build 目录', '', rule,
    ' Bash command', '   rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'];
  assert.equal(inputBox('claude', screen), false);
  assert.deepEqual(assess('claude', screen), { ok: false, reason: 'dialog' });
});

test('omp 的 +---+ 盒子贴在状态栏上面，也不是输入框', () => {
  const box = '+' + '-'.repeat(118) + '+';
  const status = ' pi · [xhi] Muse Spark 1.3 Contributor';
  assert.equal(inputBox('omp', [...Array(30).fill(''), box, '| $ touch probe.txt |', box, box, '| (no output) |', box, status]), false);
});

test('正文里出现对话框的字样，只要输入框在就不算对话框', () => {
  // 对话正文完全可能写着「Do you want to proceed」——比如正在讨论这个功能本身。
  const screen = claude('', ['它会问 Do you want to proceed? 然后 Allow once', 'Press enter to continue 是 codex 的菜单']);
  assert.equal(dialogOnScreen(screen), true, '前提：底部确实有这些字');
  assert.equal(assess('claude', screen).ok, true);
});

test('omp：空闲、忙碌、贴了字都认得输入框；权限框顶掉了它', () => {
  for (const name of ['omp-idle', 'omp-busy', 'omp-busy-pasted', 'omp-idle-after-turn']) {
    assert.equal(inputBox('omp', fixture(name)), true, name);
  }
  // 忙的时候照样发：omp 自己会排队（实测进 Steering 队列）。
  assert.equal(assess('omp', fixture('omp-busy')).ok, true);
  const approval = fixture('omp-approval');
  assert.equal(inputBox('omp', approval), false, '更新横幅也画通栏横线，但权限框是 +---+ 盒子');
  assert.deepEqual(assess('omp', approval), { ok: false, reason: 'dialog' });
});

test('codex 启动时的两个菜单：回车会执行 curl | sh 或开浏览器走 OAuth', () => {
  for (const name of ['codex-update-menu', 'codex-login']) {
    assert.equal(inputBox('codex', fixture(name)), null, '不知道 codex 的输入框长什么样');
    assert.deepEqual(assess('codex', fixture(name)), { ok: false, reason: 'dialog' }, name);
  }
});

test('编号选项只有成组出现才算菜单：用户自己写的「1.」不算', () => {
  assert.equal(dialogOnScreen(['› 1. Update now', '  2. Skip']), true);
  assert.equal(dialogOnScreen(['› 1. 先把这个修了']), false);
});

test('回显比的是「多出来」，历史里留着同样的原文骗不过去', () => {
  const text = '用 bash 在当前目录创建一个空文件 probe.txt';
  const frag = fragment(text);
  const before = screenText(view(fixture('omp-idle-after-turn')));
  const history = `${before} ${text}`;
  assert.equal(echoSeen(history, history, frag), false, '画面没变，只是历史里本来就有');
  assert.equal(echoSeen(history, `${history} ${text}`, frag), true);
  assert.equal(echoSeen(before, `${before} [Pasted text #1 +4 lines]`, fragment('a\nb\nc\nd\ne')), true, 'claude 会把长粘贴折成一个标记');
});

test('取来认回显的那一小段：第一行、压空白、最多 12 个字', () => {
  assert.equal(fragment('\n\n  第二条：写完诗之后只回复 OK'), '第二条：写完诗之后只回复');
  assert.equal(fragment('a   b\tc'), 'a b c');
  assert.equal(screenText({ rows: [{ text: 'abc', wrapped: false }, { text: 'def', wrapped: true }], cursorX: 0, cursorY: 0 }), ' abcdef',
    '终端自己折的行要接回去');
});

test('正文里的控制字符全部去掉：夹一个 ESC[201~ 就能提前结束粘贴、把后面变成按键', () => {
  assert.equal(normalize('ok\x1b[201~\rrm -rf ~\r'), 'ok[201~\nrm -rf ~');
  assert.equal(normalize('第一行\r\n第二行\t缩进\n\n'), '第一行\n第二行\t缩进');
  assert.throws(() => normalize('  \n '), (e: any) => e.code === 'invalid_request');
  assert.throws(() => normalize(42), (e: any) => e.code === 'invalid_request');
  assert.throws(() => normalize('中'.repeat(6000)), (e: any) => e.code === 'too_large', '按字节算，不是字符数');
});

/** 一个假终端：写进去的粘贴在 `echoAfter` 次轮询之后出现在输入框里。 */
function harness(opts: { rows: string[]; cli?: string | null | undefined; echoAfter?: number; afterPaste?: string[] }) {
  let rows = opts.rows, polls = 0, pasted = '', instance = 'i1', clock = 0;
  const writes: string[] = [];
  const direct = createDirectInput({
    session: id => id === 't' ? { instanceId: instance } : undefined,
    view: () => {
      if (pasted && ++polls >= (opts.echoAfter ?? 1)) {
        if (opts.afterPaste) rows = opts.afterPaste;
        else if (opts.echoAfter !== Infinity) rows = rows.map(row => row.startsWith('❯') ? `❯ ${pasted}` : row);
      }
      return view(rows);
    },
    write: (_id, data) => {
      writes.push(data);
      if (data.startsWith('\x1b[200~')) { pasted = data.slice(6, -6); polls = 0; }
      if (data === '\r') { rows = rows.map(row => row.startsWith('❯') ? '❯ ' : row); pasted = ''; }
    },
    foreground: async () => 'cli' in opts ? opts.cli : 'claude',
    sleep: async ms => { clock += ms; },
    now: () => clock,
  });
  return { direct, writes, replace: () => { instance = 'i2'; } };
}

test('贴进去、看见它、按回车', async () => {
  const h = harness({ rows: claude() });
  assert.deepEqual(await h.direct.type('t', '后续可以做什么'), { status: 'submitted', cli: 'claude' });
  assert.deepEqual(h.writes, ['\x1b[200~后续可以做什么\x1b[201~', '\r']);
});

test('选择框开着：一个字节都不写', async () => {
  const h = harness({ rows: fixture('omp-approval'), cli: 'omp' });
  assert.deepEqual(await h.direct.type('t', 'hello'), { status: 'held', reason: 'dialog', cli: 'omp' });
  assert.deepEqual(h.writes, []);
});

test('前台是 shell 或者判断不了：不写', async () => {
  const shell = harness({ rows: claude(), cli: null });
  assert.deepEqual(await shell.direct.type('t', 'ls'), { status: 'held', reason: 'not_cli', cli: null });
  const unknown = harness({ rows: claude(), cli: undefined });
  assert.deepEqual(await unknown.direct.type('t', 'ls'), { status: 'held', reason: 'foreground_unknown', cli: null });
  assert.deepEqual([...shell.writes, ...unknown.writes], []);
});

test('一直没看见回显：只贴不按回车', async () => {
  // omp 的权限框就是这样：贴进去的字哪儿都不出现。没认出那个框时，这是最后一道保险。
  const h = harness({ rows: claude(), echoAfter: Infinity });
  assert.deepEqual(await h.direct.type('t', 'hello'), { status: 'pasted', cli: 'claude' });
  assert.deepEqual(h.writes, ['\x1b[200~hello\x1b[201~']);
});

test('贴完之后弹出了对话框：不按回车', async () => {
  // 输入框没了，换成一个权限框；贴进去的字出现在别处（所以回显算看见了）。
  const dialog = [...Array(26).fill(''), ' hello', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
  const h = harness({ rows: claude(), afterPaste: dialog });
  assert.deepEqual(await h.direct.type('t', 'hello'), { status: 'pasted', cli: 'claude' });
  assert.deepEqual(h.writes, ['\x1b[200~hello\x1b[201~']);
});

test('同一个终端的两句不交错：贴、回车、贴、回车', async () => {
  const h = harness({ rows: claude(), echoAfter: 2 });
  const results = await Promise.all([h.direct.type('t', '第一句'), h.direct.type('t', '第二句')]);
  assert.deepEqual(results.map(r => r.status), ['submitted', 'submitted']);
  assert.deepEqual(h.writes, ['\x1b[200~第一句\x1b[201~', '\r', '\x1b[200~第二句\x1b[201~', '\r']);
});

test('一句失败不影响下一句', async () => {
  const h = harness({ rows: claude() });
  await assert.rejects(h.direct.type('t', ''), (e: any) => e.code === 'invalid_request');
  await assert.rejects(h.direct.type('gone', 'hi'), (e: any) => e.code === 'not_found');
  assert.equal((await h.direct.type('t', 'hi')).status, 'submitted');
});
