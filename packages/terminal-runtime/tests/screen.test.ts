import assert from "node:assert/strict";
import { test } from "node:test";
import headless from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { createScreenStore } from "../src/screen.ts";

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));
/*
  等到「解析确实追到了这一条」，而不是等一个大概够用的毫秒数。

  xterm 的 write 是异步的，几千次写在一台正忙的机器上远不止 20ms，而 parsedSeq 就是
  这个问题的准确答案。按时间等的测试只会在最不方便的时候红一次，而且红得看不出原因。
*/
async function parsedTo(screen: ReturnType<typeof createScreenStore>, id: string, seq: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((screen.snapshot(id)?.seq ?? -1) >= seq) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`screen never parsed through seq ${seq} (stopped at ${screen.snapshot(id)?.seq})`);
}

/*
  服务端持有一份解析好的屏幕，是为了回答「这个终端现在长什么样」而**不用重跑一遍折叠**。
  屏幕是字节流的折叠结果，不是切片——所以这个问题只有两种答法：持有结果，或者重算。
*/

test("a screen answers what the terminal looks like now, not how it got there", async () => {
  const screen = createScreenStore();
  // 一段会自我覆盖的输出：中间那些行在最终画面上根本不存在。
  for (let i = 1; i <= 50; i++) {
    screen.write("s", "inst", `\x1b[H\x1b[2Jstep ${i}\r\n`, i, 80, 24);
  }
  await parsedTo(screen, "s", 50);
  const snap = screen.snapshot("s");
  assert.ok(snap);
  assert.match(snap.data, /step 50/);
  assert.doesNotMatch(snap.data, /step 49/, "the snapshot must be the screen, not the history");
  assert.equal(snap.seq, 50, "the snapshot must say how far it has parsed");
});

test("a snapshot is bounded by the screen, however much output went through it", async () => {
  const screen = createScreenStore({ scrollback: 50 });
  for (let i = 1; i <= 5000; i++) screen.write("s", "inst", `line ${i}\r\n`, i, 80, 24);
  await parsedTo(screen, "s", 5000);
  const snap = screen.snapshot("s");
  assert.ok(snap);
  // 50 行回滚 + 24 行视口，远小于灌进去的 5000 行。
  assert.ok(snap.data.split("\n").length <= 80, `snapshot kept ${snap.data.split("\n").length} lines`);
  assert.match(snap.data, /line 5000/);
  assert.doesNotMatch(snap.data, /line 1\b/);
});

test("a new shell gets a new screen rather than painting onto the old one", async () => {
  const screen = createScreenStore();
  screen.write("s", "first", "from the old shell\r\n", 1, 80, 24);
  await settle();
  screen.write("s", "second", "from the new shell\r\n", 1, 80, 24);
  await settle();
  const snap = screen.snapshot("s");
  assert.ok(snap);
  assert.match(snap.data, /from the new shell/);
  assert.doesNotMatch(snap.data, /from the old shell/, "a new instance must not inherit the old grid");
  assert.equal(screen.instanceOf("s"), "second");
});

/*
  这块屏幕跑在 pty.onData 的回调里。它出任何问题都只能自己咽下去——为了「重连时好看
  一点」的优化把终端的输出路径弄断，这个交易任何时候都不划算。
*/
test("a screen never throws into the output path, whatever it is handed", async () => {
  const screen = createScreenStore();
  // 尺寸缺失/非法：不能抛，按合理默认开着，等 resize 纠正。
  assert.doesNotThrow(() => screen.write("s", "i", "hi\r\n", 1, Number.NaN, -3));
  assert.doesNotThrow(() => screen.resize("s", 0, 0));
  assert.doesNotThrow(() => screen.resize("nope", 80, 24));
  assert.doesNotThrow(() => screen.write("s", "i", "", 2, 80, 24));
  await settle();
  assert.ok(screen.snapshot("s"), "a sane default must still produce a usable screen");
  assert.equal(screen.snapshot("nope"), null, "an unknown session simply has no screen");
});

test("dropping a screen releases it and stops answering for it", async () => {
  const screen = createScreenStore();
  screen.write("s", "i", "content\r\n", 1, 80, 24);
  await settle();
  assert.ok(screen.snapshot("s"));
  screen.drop("s");
  assert.equal(screen.snapshot("s"), null);
  assert.equal(screen.instanceOf("s"), null);
  assert.doesNotThrow(() => screen.drop("s"));
  assert.doesNotThrow(() => screen.dispose());
});

// Use the browser's Unicode provider as the live-output reference. Restoring the
// server's serialized grid must preserve cells, wrapping and the cursor, so the
// next incremental output lands in the same place as uninterrupted live output.
for (const [name, data] of [
  ['cursor positioning', 'A🙂B\x1b[1;5HX\r\n中文🙂尾'],
  ['wide-character wrapping', 'x'.repeat(19) + '🙂中文Z\r\nDONE'],
  ['alternate screen', '\x1b[?1049h\x1b[1;1H标题🙂\x1b[5;1HA🙂B\x1b[5;5HX\x1b[6;1H状态🙂\x1b[5;6H'],
] as const) {
  test(`server snapshot matches live Unicode 11 output: ${name}`, async t => {
    const { Terminal } = headless;
    const screen = createScreenStore();
    const make = () => {
      const terminal = new Terminal({ cols: 20, rows: 6, scrollback: 2000, allowProposedApi: true });
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = '11';
      t.after(() => terminal.dispose());
      return terminal;
    };
    const live = make(), restored = make();
    t.after(() => screen.dispose());
    const write = (terminal: InstanceType<typeof Terminal>, text: string) =>
      new Promise<void>(resolve => terminal.write(text, resolve));
    const grid = (terminal: InstanceType<typeof Terminal>) => {
      const buffer = terminal.buffer.active;
      return {
        type: buffer.type, baseY: buffer.baseY, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
        lines: Array.from({ length: buffer.length }, (_, row) => {
          const line = buffer.getLine(row)!;
          return { wrapped: line.isWrapped, cells: Array.from({ length: terminal.cols }, (_, col) => {
            const cell = line.getCell(col)!;
            return { chars: cell.getChars(), width: cell.getWidth() };
          }) };
        }),
      };
    };
    screen.write('unicode', 'instance', data, 1, 20, 6);
    await write(live, data);
    await parsedTo(screen, 'unicode', 1);
    const snapshot = screen.snapshot('unicode');
    assert.ok(snapshot);
    await write(restored, snapshot.data);
    assert.deepEqual(grid(restored), grid(live), 'restoration changed the live grid');

    const tail = '\x1b[1D!\r\n尾🙂END';
    await Promise.all([write(live, tail), write(restored, tail)]);
    assert.deepEqual(grid(restored), grid(live), 'incremental output landed differently after restoration');
  });
}
