/*
  全量重放必须从 normal buffer 开始。

  服务端那份快照的形状是「normal 回滚 → `?1049h` → alt 内容」（实测 SerializeAddon 就是
  这么排的）。要是重放开始时客户端**已经在 alt screen 里**，那个 `?1049h` 就成了 no-op
  ——而正是它负责保存 normal buffer 并清空 alt buffer。于是前半截回滚被画进 alt buffer，
  等 TUI 一退出就跟着没了。tty7 的 CHANGELOG 记了同一个坑（research/tty7-lessons.md 零件 3）。

  这条不变式今天是靠两件事一起成立的：`createResume` 在写全量基线前先调 `sink.reset()`，
  而引擎的 `reset()` 里那句 `term.reset()` 会回到 normal buffer
  （`features/terminal/engine/xtermEngine.ts`）。之前没有任何断言钉着这个组合。

  **这条测的是组合出来的行为，不是引擎本身**：替身的 reset 照 xtermEngine 的顺序做同样的
  事。引擎那半要连真 DOM 才跑得起来，在 tests/browser/ 那套里。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { createResume } from '../src/features/terminal/session/resume';

const { Terminal } = headless;
const write = (term: InstanceType<typeof Terminal>, data: string) => new Promise<void>((resolve) => term.write(data, resolve));
const allLines = (term: InstanceType<typeof Terminal>) => {
  const buffer = term.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true)).join('\n');
};

test('重放一份「回滚 + alt 屏」的快照时，客户端要先回到 normal buffer', async (t) => {
  const source = new Terminal({ cols: 40, rows: 6, scrollback: 200, allowProposedApi: true });
  const serializer = new SerializeAddon();
  source.loadAddon(serializer);
  const destination = new Terminal({ cols: 40, rows: 6, scrollback: 200, allowProposedApi: true });
  t.after(() => { source.dispose(); destination.dispose(); });

  await write(source, 'SCROLLBACK-LINE\r\n');
  await write(source, '\x1b[?1049h');
  await write(source, 'ALT-CONTENT');

  // 重连前这个标签页正停在别的 TUI 的备用屏上。
  await write(destination, '\x1b[?1049hOLD-ALT');
  assert.equal(destination.buffer.active.type, 'alternate', '前提没摆对，这条测试就什么都没测到');

  const resume = createResume({
    get cols() { return destination.cols; },
    get rows() { return destination.rows; },
    resize: (cols, rows) => destination.resize(cols, rows),
    reset: () => { destination.reset(); destination.clear(); },
    snapshot: () => null,
    write: (data, done) => destination.write(data, done),
  });
  t.after(() => resume.dispose());
  await resume.prepare('pty', null, false, { cols: 40, rows: 6 });
  await resume.accept({ type: 'replay', instanceId: 'pty', seq: 1, data: serializer.serialize({ scrollback: 200 }), cols: 40, rows: 6 }).done;

  assert.equal(destination.buffer.active.type, 'alternate', '快照自带的 ?1049h 应该真的生效');
  assert.match(allLines(destination), /ALT-CONTENT/);

  // TUI 退出，回到 normal——回滚必须还在那儿，而且不能混进上一个 TUI 的备用屏内容。
  await write(destination, '\x1b[?1049l');
  const normal = allLines(destination);
  assert.match(normal, /SCROLLBACK-LINE/, '回滚被画进了 alt buffer，随 TUI 退出一起丢了');
  assert.doesNotMatch(normal, /OLD-ALT/, '上一个 TUI 的备用屏内容漏进了 normal buffer');
});
