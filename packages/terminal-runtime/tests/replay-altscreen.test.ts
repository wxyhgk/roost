/*
  降级重放要把「现在在备用屏」带回去。

  服务端网格拿不出画面时（坏了，或者解析进度落在环的淘汰线后面），重放退回发原始 chunk。
  进备用屏的那条 `?1049h` 很可能早就被内存上限挤出环外了——客户端于是在 normal buffer 里
  画 TUI 的整屏输出，回滚被一份份画面顶上去，TUI 退出也回不来。omp / codex 这种整屏重绘的
  CLI 最容易撞上，实际用起来就是「resume 一次，历史里多一份界面」。

  见 issues/2026-09-16-alt-screen-lost-when-server-screen-breaks.md。
*/
import assert from "node:assert/strict";
import { test } from "node:test";

const { createReplayStore } = await import("../src/replay.ts");

const ALT_ENTER = "\x1b[?1049h";

/** 只回答两件事的假网格：画面拿不拿得出来、现在在不在备用屏。 */
function store(options: { alt: boolean | null; snapshot?: string | null }) {
  const saved = new Map<string, { raw: string; snapshot: string | null; stateJson?: string | null }>();
  return createReplayStore({
    getTerminalReplay: (id) => saved.get(id),
    setTerminalReplay: (id, raw, snapshot, stateJson) => { saved.set(id, { raw, snapshot, stateJson }); },
    deleteTerminalReplay: (id) => { saved.delete(id); },
  }, {
    snapshot: () => options.snapshot ? { data: options.snapshot, seq: 1, cols: 80, rows: 24 } : null,
    altScreen: () => options.alt,
  });
}

function session(replay: ReturnType<typeof createReplayStore>, id: string, chunks: string[]) {
  replay.hydrate(id);
  for (const chunk of chunks) replay.append(id, chunk);
}

test("网格拿不出画面、环里也没有 ?1049h 时，补一条", () => {
  const replay = store({ alt: true });
  session(replay, "s", ["TUI 的第 N 次整屏重绘"]);
  const frame = replay.resume("s")!;
  assert.ok(frame.data.startsWith(ALT_ENTER), "少了它，整屏就画进 normal buffer，历史被一份份界面顶上去");
  assert.ok(frame.data.includes("TUI 的第 N 次整屏重绘"));
});

/* 补重了会让客户端多清一次 alt buffer——tty7 记下的正是这个坑。 */
test("环里已经带着就不补", () => {
  const replay = store({ alt: true });
  session(replay, "s", [`${ALT_ENTER}进了备用屏，后面都是整屏重绘`]);
  const frame = replay.resume("s")!;
  assert.equal(frame.data.indexOf(ALT_ENTER), frame.data.lastIndexOf(ALT_ENTER), "只能有一条");
});

test("刚退出备用屏（环里有 ?1049l）也不补", () => {
  const replay = store({ alt: true });
  session(replay, "s", ["\x1b[?1049l回到普通屏了"]);
  const frame = replay.resume("s")!;
  assert.ok(!frame.data.includes(ALT_ENTER), "环自己说明了状态，就该听环的");
});

test("不在备用屏、或者根本不知道，都不补", () => {
  for (const alt of [false, null]) {
    const replay = store({ alt });
    session(replay, "s", ["ls -la 的普通输出"]);
    assert.ok(!replay.resume("s")!.data.includes(ALT_ENTER), `alt=${alt}`);
  }
});

/* 快照那条路不需要补：序列化出来的形状自带 ?1049h，补了就是重复。 */
test("走服务端快照时一个字都不加", () => {
  const replay = store({ alt: true, snapshot: `回滚${ALT_ENTER}alt 内容` });
  session(replay, "s", ["后续增量"]);
  const frame = replay.resume("s")!;
  assert.equal(frame.data.indexOf(ALT_ENTER), frame.data.lastIndexOf(ALT_ENTER));
  assert.ok(!frame.data.startsWith(ALT_ENTER), "快照自带的那条在它自己的位置上，不该被前缀盖过");
});
