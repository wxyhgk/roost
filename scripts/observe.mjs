/*
  一条命令同时看见两块「画面」：终端此刻的屏幕，和对话面板此刻的内容。

  **为什么要有它。** 调这条 GUI→TUI 链路时，每一步都要问同样几个问题：终端画面现在长什么样、
  写入闸放不放行、输入框里是什么、对话里存进去了没有、待发那条卡在哪。这一天里我手写了
  四遍一次性的采样脚本，每次用完就扔，而且每次都因为取错字段绕过弯路（把只在变化时写库的
  `reason` 当成当前状态读，就误判过一次）。

  **判定取自守护进程本身**，不是这里重算的：`commandControl` 返回的 reason 和 composer
  就是写入闸当时依据的那一份。画面文本另外从 `terminal_replay` 的快照里渲染出来，
  用的是同一个渲染器（`createClaudeScreen`），所以看到的和它看到的是同一块屏。

  用法：
    node --import tsx scripts/observe.mjs                 列出可观测的终端
    node --import tsx scripts/observe.mjs s_xxx           打一份快照
    node --import tsx scripts/observe.mjs s_xxx --watch   只在变化时打印
    node --import tsx scripts/observe.mjs s_xxx --capture <名字>
        把此刻的屏幕原样存成金样本，供 tests/screens 下的用例回放。
        **CLI 升级换了界面时，就是靠这个发现的**——2026-09-22 的 `auto mode` 页脚
        漂移让整条链静默停摆，而当时没有任何用例会失败。
*/
import {homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {realpath, mkdir, writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {connectTerminalDaemon, daemonSocketPath} from '@roost/terminal-daemon';
import headless from '@xterm/headless';
import {classifyClaudeComposer, claudeComposerContent} from '@roost/terminal-daemon/claude-screen';
const {Terminal} = headless;

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const terminalId = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--capture' && args[args.indexOf(a) - 1] !== '--lines');
const tail = Number(value('--lines') ?? 14);

const dir = await realpath(process.env.ROOST_DATA_DIR ?? join(homedir(), '.roost'));
const db = new DatabaseSync(join(dir, 'workspace.sqlite'), {readOnly: true});
const client = await connectTerminalDaemon(daemonSocketPath(dir));

/**
 * 终端的屏幕：从守护进程存下来的快照里渲染成行。
 *
 * 宽度按画面上最长的那条横线推——输入框的边框就是整宽的，这比猜一个 80 可靠。
 * 宽度猜错的代价很实在：一次实测里按 120 列渲染，长行折了，光标落到了续行上，
 * 于是「光标那一行是不是 ❯」怎么都不成立，整块画面被判成认不出。
 */
async function screenOf(id) {
  const row = db.prepare('select state_json from terminal_replay where session_id=?').get(id);
  if (!row) return null;
  const state = JSON.parse(row.state_json);
  const data = state.snapshot?.data ?? '';
  const runs = [...data.matchAll(/─+/g)].map(m => m[0].length).sort((a, b) => b - a);
  const cols = runs[0] ?? 80, rows = 40;
  const term = new Terminal({cols, rows, scrollback: 0, allowProposedApi: true});
  await new Promise(r => term.write(state.history ?? '', () => r()));
  await new Promise(r => term.write(data, () => r()));
  const buffer = term.buffer.active;
  const lines = Array.from({length: rows}, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '');
  term.dispose();
  return {cols, lines, cursorY: buffer.cursorY, cursorX: buffer.cursorX};
}

/** 输入框那一块：上下边框各外扩一点，够判定用，又不会把整屏内容带走。 */
function composerSlice(view) {
  const isBorder = line => /^\s*[─━]{8,}\s*$/.test(line ?? '');
  let top = -1, bottom = -1;
  for (let i = view.cursorY; i >= 0 && view.cursorY - i <= 14; i--) if (isBorder(view.lines[i])) { top = i; break; }
  for (let i = view.cursorY; i < view.lines.length && i - view.cursorY <= 14; i++) if (isBorder(view.lines[i])) { bottom = i; break; }
  if (top < 0 || bottom <= top) return null;
  const from = Math.max(0, top - 1), to = Math.min(view.lines.length, bottom + 3);
  return {lines: view.lines.slice(from, to), cursorY: view.cursorY - from, cursorX: view.cursorX};
}

const binding = id => {
  const row = db.prepare('select record_json from ai_session_records where session_id=?').get(id);
  return row ? JSON.parse(row.record_json).binding : null;
};

function conversationOf(nativeId) {
  const src = db.prepare('select conversation_id,legacy_conversation_id from conversation_sources where native_session_id=?').get(nativeId);
  if (!src) return null;
  const title = db.prepare('select title from conversation_catalog where id=?').get(src.conversation_id);
  const rows = db.prepare(`select preview_json from ai_history_messages where conversation_id=?
    order by seq desc limit ?`).all(src.legacy_conversation_id, tail).reverse();
  const pending = db.prepare(`select d.id,d.state,d.reason,m.body from peer_deliveries d
    join peer_messages m on m.id=d.message_id
    where d.recipient_id=? and d.state in ('queued','dispatching','uncertain') order by d.rowid`).all(src.conversation_id);
  return {id: src.conversation_id, title: title?.title ?? null, rows, pending};
}

const oneLine = (text, width = 56) => String(text ?? '').replace(/\s+/g, ' ').slice(0, width);

async function snapshot(id) {
  const live = client.getSession(id);
  const b = binding(id);
  const control = await client.commandControl(id).catch(e => ({error: String(e.message ?? e)}));
  const rendered = await screenOf(id);
  const verdict = rendered && classifyClaudeComposer(rendered.lines, rendered.cursorY, rendered.cursorX, true);
  const composer = rendered && claudeComposerContent(rendered.lines, rendered.cursorY);
  const out = [];
  out.push(`终端 ${id}  pty ${(live?.instanceId ?? '—').slice(0, 8)}  cli ${live?.cli ?? '—'}`);
  if (b) out.push(`绑定 pty ${b.terminalInstanceId.slice(0, 8)}  native ${b.nativeSessionId.slice(0, 8)}  ${b.state}`
    + (live && b.terminalInstanceId !== live.instanceId ? '   ← 和活着的那条对不上' : ''));
  if (rendered) {
    out.push(`画面 ${rendered.cols} 列  光标 ${rendered.cursorY},${rendered.cursorX}  判定 ${verdict}`);
    out.push(`输入框 ${composer === null ? '（认不出）' : JSON.stringify(oneLine(composer))}`);
  }
  out.push(`写入闸 supported=${control.supported} reason=${JSON.stringify(control.reason)} 队列=${control.queue?.length ?? '—'}`
    + (control.error ? `  错误 ${control.error}` : ''));
  const conv = b && conversationOf(b.nativeSessionId);
  if (conv) {
    out.push(`对话 ${conv.id.slice(0, 8)}「${conv.title ?? '—'}」最近 ${conv.rows.length} 条`);
    for (const row of conv.rows) {
      const e = JSON.parse(row.preview_json);
      out.push(`  ${String(e.role).padEnd(9)} ${oneLine(e.content)}`);
    }
    out.push(conv.pending.length ? `待发 ${conv.pending.length} 条` : '待发 无');
    for (const p of conv.pending) out.push(`  ${p.id.slice(0, 8)} ${p.state}/${p.reason ?? '—'}  ${oneLine(p.body, 30)}`);
  }
  return out.join('\n');
}

try {
  if (!terminalId) {
    console.log('可观测的终端：');
    for (const s of client.listSessions()) console.log(`  ${s.id.padEnd(14)} ${String(s.cli ?? '—').padEnd(9)} ${s.instanceId.slice(0, 8)}`);
    console.log('\n用法： node --import tsx scripts/observe.mjs <终端 id> [--watch] [--lines N] [--capture 名字]');
  } else if (flag('--capture')) {
    const name = value('--capture');
    if (!name || !/^[a-z0-9-]+$/i.test(name)) throw new Error('--capture 需要一个 [a-z0-9-] 的名字');
    const rendered = await screenOf(terminalId);
    const slice = rendered && composerSlice(rendered);
    if (!slice) throw new Error('这一帧里找不到输入框，换个时机再抓');
    const verdict = classifyClaudeComposer(slice.lines, slice.cursorY, slice.cursorX, true);
    const path = join(process.cwd(), 'packages/terminal-daemon/tests/screens', `${name}.json`);
    await mkdir(dirname(path), {recursive: true});
    /*
      **只存输入框那一块**，不存整屏。判定需要的就是这几行（边框、`❯`、页脚），而整屏
      会把当时的工作内容和路径一起带进仓库。抓下来的帧是界面形状的样本，不是内容的样本。
    */
    await writeFile(path, JSON.stringify({
      cli: client.getSession(terminalId)?.cli ?? null,
      capturedAt: new Date().toISOString().slice(0, 10),
      cols: rendered.cols, cursorY: slice.cursorY, cursorX: slice.cursorX,
      expect: verdict, lines: slice.lines,
    }, null, 2) + '\n');
    console.log(`已存 ${path}\n此刻判定 ${verdict}`);
    console.log('确认这个判定是**对的**再提交——用例会把它当成应有的答案。');
  } else if (flag('--watch')) {
    let last = '';
    for (;;) {
      const now = await snapshot(terminalId);
      if (now !== last) { console.log(`\n── ${new Date().toLocaleTimeString()} ──\n${now}`); last = now; }
      await new Promise(r => setTimeout(r, 1000));
    }
  } else {
    console.log(await snapshot(terminalId));
  }
} finally { client.dispose(); db.close(); }
