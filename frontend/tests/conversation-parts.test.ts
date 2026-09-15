import { test } from "node:test";
import assert from "node:assert/strict";
import { buildItems, groupMessages, type Row } from "../src/features/conversations/parts.ts";
import type { HistoryMessage, MessagePart } from "../src/shared/api/conversationPayloads.ts";

let seq = 0;
const msg = (role: string, content: string, parts?: MessagePart[]): HistoryMessage => ({
  messageId: `m${++seq}`, historySeq: seq, bodyState: "stored", sourceRevision: 1,
  event: { eventId: `e${seq}`, role, content, ...(parts ? { data: { parts } } : {}) },
});
const kinds = (rows: Row[]) => rows.map(r => `${r.role}:${r.blocks.map(b => b.kind).join(",")}`);

/*
  **工具调用和它的结果不在同一条消息里。** Claude 的 transcript 把 tool_result 放进紧接着的
  那条 user 消息。原样渲染会有两个后果：输出和调用离散在两处；用户看到自己"说"了一堆
  从没说过的话——那条 user 消息其实只装着工具结果。
*/
test("a tool call pairs with the result that arrives in the next message", () => {
  const rows = groupMessages([
    msg("user", "跑一下测试"),
    msg("assistant", "好的", [
      { type: "text", text: "好的" },
      { type: "tool_call", name: "Bash", toolCallId: "c1", text: "Bash: npm test" },
    ]),
    msg("user", "", [{ type: "tool_result", toolCallId: "c1", text: "212 passed" }]),
    msg("assistant", "都过了", [{ type: "text", text: "都过了" }]),
  ]);
  assert.deepEqual(kinds(rows), ["user:text", "assistant:text,tool", "assistant:text"],
    "只装工具结果的那条合成 user 消息不该出现");
  const tool = rows[1].blocks[1];
  assert.equal(tool.kind === "tool" && tool.name, "Bash");
  assert.equal(tool.kind === "tool" && tool.args, "npm test", "工具名不该在参数里重复一遍");
  assert.equal(tool.kind === "tool" && tool.result, "212 passed");
  assert.equal(tool.kind === "tool" && tool.failed, false);
});

test("a failed tool keeps its output and is marked failed", () => {
  const rows = groupMessages([
    msg("assistant", "", [{ type: "tool_call", name: "Bash", toolCallId: "c1", text: "Bash: exit 1" }]),
    msg("user", "", [{ type: "tool_error", toolCallId: "c1", text: "exit code 1" }]),
  ]);
  const tool = rows[0].blocks[0];
  assert.equal(tool.kind === "tool" && tool.failed, true);
  assert.equal(tool.kind === "tool" && tool.result, "exit code 1");
});

/*
  配不上对的结果仍然要显示：历史被截断、或调用发生在拉取范围之外时就会这样。
  **默默丢掉比显示一个孤儿更糟**——用户会以为那一步压根没发生。
*/
test("a result whose call is outside the fetched range is still shown", () => {
  const rows = groupMessages([msg("user", "", [{ type: "tool_result", toolCallId: "gone", text: "输出" }])]);
  assert.equal(rows.length, 1);
  const tool = rows[0].blocks[0];
  assert.equal(tool.kind === "tool" && tool.result, "输出");
});

/* 老数据、以及只有正文才带 parts 的行：退回按 content 渲染，一个字都不丢。 */
test("a message without parts falls back to its flattened content", () => {
  const rows = groupMessages([msg("assistant", "纯文本回复")]);
  assert.deepEqual(kinds(rows), ["assistant:text"]);
  assert.equal(rows[0].blocks[0].kind === "text" && rows[0].blocks[0].text, "纯文本回复");
});

test("consecutive text parts become one paragraph run, and empty parts are dropped", () => {
  const rows = groupMessages([msg("assistant", "", [
    { type: "text", text: "第一段" }, { type: "text", text: "  " }, { type: "text", text: "第二段" },
  ])]);
  assert.deepEqual(kinds(rows), ["assistant:text"]);
  assert.equal(rows[0].blocks[0].kind === "text" && rows[0].blocks[0].text, "第一段\n\n第二段");
});

import { buildItems, MIN_GROUPED_TOOLS, toolsStatus } from "../src/features/conversations/parts.ts";

const call = (id: string, name = "Bash"): MessagePart => ({ type: "tool_call", name, toolCallId: id, text: `${name}: cmd` });
const done = (id: string): MessagePart => ({ type: "tool_result", toolCallId: id, text: "ok" });
const shapes = (items: ReturnType<typeof buildItems>) =>
  items.map(i => i.kind === "text" ? `text(${i.role})${i.turnStart ? "*" : ""}` : `tools×${i.tools.length}:${i.status}`);

/*
  一次回合里工具调用可以有十几次，一条条平铺就是一片噪音。而「连续」是**跨消息**的：
  AI 往往是「调用 → （下一条消息里的结果）→ 再调用」，中间那条只装结果的消息已经被去掉了。
*/
test("consecutive tool calls across messages collapse into one group", () => {
  const rows = groupMessages([
    msg("user", "跑测试"),
    msg("assistant", "", [call("c1")]),
    msg("user", "", [done("c1")]),
    msg("assistant", "", [call("c2"), call("c3")]),
    msg("user", "", [done("c2"), done("c3")]),
    msg("assistant", "都过了", [{ type: "text", text: "都过了" }]),
  ]);
  assert.deepEqual(shapes(buildItems(rows)), ["text(user)*", "tools×3:completed", "text(assistant)"]);
});

/* 把一两次调用收进一个要点开的组，等于用一次点击换零信息。 */
test("a run shorter than the grouping threshold stays laid out", () => {
  const rows = groupMessages([msg("assistant", "", [call("c1"), call("c2")]), msg("user", "", [done("c1"), done("c2")])]);
  const items = buildItems(rows);
  assert.equal(items.length, MIN_GROUPED_TOOLS - 1);
  assert.ok(items.every(i => i.kind === "tools" && i.tools.length === 1));
});

/* 「还没结束」压过「其中有失败」——摘要先要回答的是「这一步做完了没有」。 */
test("a group is running while any tool has not returned, even if another failed", () => {
  assert.equal(toolsStatus([{ kind: "tool", id: "a", name: "", args: "", result: "x", failed: true },
                            { kind: "tool", id: "b", name: "", args: "", result: null, failed: false }]), "running");
  assert.equal(toolsStatus([{ kind: "tool", id: "a", name: "", args: "", result: "x", failed: true }]), "error");
});

/* 一个回合从用户说话开始。没有这条边界，「提问 → 十几次工具 → 回答」在长对话里会糊成一片。 */
test("a turn boundary is marked on the user message that starts it", () => {
  const rows = groupMessages([msg("user", "问题一"), msg("assistant", "答一"), msg("user", "问题二")]);
  assert.deepEqual(shapes(buildItems(rows)), ["text(user)*", "text(assistant)", "text(user)*"]);
});

import { turnDiff, type ToolBlock } from "../src/features/conversations/parts.ts";

const edit = (path: string, plus: number, minus: number, truncated = false): ToolBlock => ({
  kind: "tool", id: path + plus, name: "Edit", args: path, result: "ok", failed: false,
  patch: { filePath: path, truncated, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    lines: [...Array(plus).fill("+new"), ...Array(minus).fill("-old"), " keep"] }] },
});

/*
  一个回合常常反复改同一个文件。**逐条列出「Edit 某文件」是噪音，合成一行 `+12 −4` 才是答案。**
  规则取自 orca 的 native-chat-turn-diffs。
*/
test("edits to the same file within a turn add up", () => {
  const diff = turnDiff([edit("src/a.ts", 3, 1), edit("src/b.ts", 2, 0), edit("src/a.ts", 5, 4)])!;
  assert.equal(diff.files.length, 2);
  assert.deepEqual(diff.files.find(f => f.path === "src/a.ts"), { path: "src/a.ts", added: 8, removed: 5, truncated: false });
  assert.equal(diff.added, 10);
  assert.equal(diff.removed, 5);
});

/* 任何一段被截断，总数就只是下界——必须说出来，不能把截断过的数字当成准确值报出去。 */
test("truncation is sticky and reaches the total", () => {
  const diff = turnDiff([edit("src/a.ts", 1, 0, true), edit("src/a.ts", 1, 0, false)])!;
  assert.equal(diff.files[0].truncated, true);
  assert.equal(diff.truncated, true);
});

test("a turn with no recorded edit has no rollup at all", () => {
  const ran: ToolBlock = { kind: "tool", id: "c", name: "Bash", args: "ls", result: "ok", failed: false };
  assert.equal(turnDiff([ran]), null);
});

/* 汇总只有事后才算得出来，所以它落在这个回合的末尾、下一个回合开始之前。 */
test("the rollup lands at the end of the turn that produced it", () => {
  const withPatch = (id: string, path: string): MessagePart[] =>
    [{ type: "tool_call", name: "Edit", toolCallId: id, text: `Edit: ${path}` }];
  const resultWith = (id: string, path: string): MessagePart[] =>
    [{ type: "tool_result", toolCallId: id, text: "ok",
       patch: { filePath: path, truncated: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+x"] }] } }];
  const rows = groupMessages([
    msg("user", "改一下"),
    msg("assistant", "", withPatch("c1", "src/a.ts")),
    msg("user", "", resultWith("c1", "src/a.ts")),
    msg("user", "再问一句"),
  ]);
  assert.deepEqual(buildItems(rows).map(i => i.kind), ["text", "tools", "diff", "text"]);
});

/*
  **「用户不让跑」和「跑了但失败」是两件事。** 解析器读记录级的 `toolDenialKind` 把它们分开
  （`packages/ai-transcript/src/claude.ts`，实测 87 条 is_error 里有 21 条命令根本没执行过）。
  这里只负责别把它们又合回去：`denied` 的调用不能同时是 `failed`，否则对话里会出现一次
  没发生过的故障。
*/
test("a denied tool use is marked denied, not failed", () => {
  const rows = groupMessages([
    msg("assistant", "", [{ type: "tool_call", name: "Bash", toolCallId: "c1", text: "Bash: rm -rf /w" }]),
    msg("user", "", [{ type: "tool_denied", toolCallId: "c1", text: "这次调用被拒绝了" }]),
  ]);
  const tool = rows[0].blocks[0];
  assert.equal(tool.kind === "tool" && tool.denied, true);
  assert.equal(tool.kind === "tool" && tool.failed, false, "没跑不是跑失败");
  assert.equal(tool.kind === "tool" && tool.result, "这次调用被拒绝了", "拒绝的说明也是结果");
});

/* 配不上对的结果仍然要显示——历史被截断时会这样。孤儿也得把「拒绝」和「失败」分开。 */
test("an orphan denial keeps the distinction too", () => {
  const rows = groupMessages([msg("user", "", [{ type: "tool_denied", toolCallId: "gone", text: "被拒绝" }])]);
  const tool = rows[0].blocks[0];
  assert.equal(tool.kind === "tool" && tool.denied, true);
  assert.equal(tool.kind === "tool" && tool.failed, false);
});

/* 拒绝不算 error：它没跑，也就没失败。组头只有三种颜色，这里不为它加第四种。 */
test("a denied tool does not turn its group red", () => {
  assert.equal(toolsStatus([{ kind: "tool", id: "a", name: "", args: "", result: "x", failed: false, denied: true }]),
    "completed");
});

test("/compact 的摘要不是用户发言：单独成条，也不开新回合", () => {
  /*
    Claude Code 把压缩摘要写成一条 role:"user" 的普通记录，只用记录级的 isCompactSummary
    标记它（本机实测每条 14000 字起）。当普通文本画会得到一条巨型用户气泡；而且因为是
    user 角色，还会凭空多画一条回合边界——压缩发生在一个回合中间，不是用户说了新的话。
  */
  const items = buildItems(groupMessages([
    msg("user", "帮我改一下", [{ type: "text", text: "帮我改一下" }]),
    msg("assistant", "好的", [{ type: "text", text: "好的" }]),
    msg("user", "", [{ type: "compaction", text: "这段对话的摘要……" }]),
    msg("assistant", "接着说", [{ type: "text", text: "接着说" }]),
  ]));
  const compaction = items.filter(i => i.kind === "compaction");
  assert.equal(compaction.length, 1, "压缩摘要要单独成条");
  assert.equal(items.filter(i => i.turnStart).length, 1, "只有真正的用户发言开新回合");
  // 内容不能丢：摘要是那段历史唯一剩下的东西。
  assert.match((compaction[0] as { text: string }).text, /这段对话的摘要/);
});

/*
  历史是分页拉的：第一页往往从一次回合的中间开始，于是 tool_call 落在窗口之外、只有
  tool_result 在里面。`groupMessages` 会把这个配不上对的结果当孤儿留下（丢掉更糟——用户
  会以为那一步没发生），而装着它的是 Claude 合成的 user 回合，那条消息因此不会被丢掉。

  这个用例钉的是：**孤儿结果不能让整组工具挂上「用户」这个角色**。挂上之后渲染层的
  `mine = role === "user"` 会把它靠右排成用户气泡，头上标「你」——用户从没调用过任何工具。
*/
test("an orphaned tool result stays the agent's action, not the user's", () => {
  const rows = groupMessages([
    // 这条就是分页边界：结果在，调用不在。
    msg("user", "", [{ type: "tool_result", toolCallId: "gone", text: "212 passed" }]),
    msg("assistant", "", [{ type: "tool_call", name: "Read", toolCallId: "c2", text: "Read: a.ts" }]),
    msg("user", "", [{ type: "tool_result", toolCallId: "c2", text: "…" }]),
  ]);
  assert.equal(rows[0].role, "user", "承载孤儿的那条消息本身确实是 user——这一层不动它");

  const items = buildItems(rows);
  const tools = items.filter(item => item.kind === "tools");
  assert.ok(tools.length > 0, "孤儿结果要留在条目里");
  for (const item of tools) {
    assert.equal(item.kind === "tools" && item.role, "assistant",
      "工具条目一律算 AI 的动作，不跟着承载它的消息角色走");
  }
});

/*
  **上下文注入不是谁说的话。** Claude Code 把「这次对话模型实际看到了什么」写成独立的
  `attachment` 记录（系统提示词快照、环境信息、被改过的文件、技能清单），解析器折成
  `type: "context"` 的段送过来。它不该开回合，也不该被当成普通正文合并进上一段。
*/
const ctxPart = (kind: string, text: string, tier: "inline" | "collapsed" = "collapsed", subject?: string): MessagePart =>
  ({ type: "context", text, context: { kind, tier, length: text.length, ...(subject ? { subject } : {}) } });

test("a context injection becomes its own row and never opens a turn", () => {
  const rows = groupMessages([
    msg("user", "跑一下测试"),
    msg("context", "当前工作目录 /w", [ctxPart("environment", "当前工作目录 /w")]),
    msg("assistant", "好的", [{ type: "text", text: "好的" }]),
  ]);
  assert.deepEqual(kinds(rows), ["user:text", "context:context", "assistant:text"]);
  const block = rows[1].blocks[0];
  assert.equal(block.kind === "context" && block.contextKind, "environment");
  assert.equal(block.kind === "context" && block.tier, "collapsed");

  const items = buildItems(rows);
  assert.deepEqual(items.map(i => i.kind === "text" ? `${i.role}${i.context ? ":" + i.context.kind : ""}` : i.kind),
    ["user", "context:environment", "assistant"]);
  assert.equal(items[1].turnStart, false, "注入不该画出一条回合边界");
  assert.equal(items.filter(i => i.turnStart).length, 1, "只有用户那一条开回合");
});

/*
  **注入不许打断工具组。** 实测 777 条注入里有 472 条落在一次工具循环**中间**——Bash 里
  `cd` 一下就有一条 `environment`，工具改了文件就有一条 `edited_text_file`。在那里断开，
  「六次调用」在界面上就变成「三次 + 一条注入 + 三次」，而那条边界不对应任何一件事。
*/
test("an injection in the middle of a tool loop lands after the group instead of splitting it", () => {
  const call = (id: string) => msg("assistant", "", [{ type: "tool_call", name: "Bash", toolCallId: id, text: `Bash: ${id}` }]);
  const result = (id: string) => msg("user", "", [{ type: "tool_result", toolCallId: id, text: "ok" }]);
  const items = buildItems(groupMessages([
    call("c1"), result("c1"),
    msg("context", "/w/a.ts 变了", [ctxPart("edited_text_file", "/w/a.ts 变了", "inline", "/w/a.ts")]),
    call("c2"), result("c2"), call("c3"), result("c3"),
    msg("assistant", "都过了", [{ type: "text", text: "都过了" }]),
  ]));
  assert.deepEqual(items.map(i => i.kind === "text" ? (i.context ? "context" : "text") : i.kind),
    ["tools", "context", "text"], "三次调用仍然是一组，注入排在这一组后面");
  const group = items[0];
  assert.equal(group.kind === "tools" && group.tools.length, 3);
  const injected = items[1];
  assert.equal(injected.kind === "text" && injected.context?.tier, "inline");
  assert.equal(injected.kind === "text" && injected.context?.subject, "/w/a.ts");
});

/* 老数据没有 `context` 字段：那就是一段普通文本，不该因此丢内容或者报错。 */
test("a context part without metadata falls back to plain text", () => {
  const rows = groupMessages([msg("context", "旧记录", [{ type: "context", text: "旧记录" }])]);
  assert.deepEqual(kinds(rows), ["context:text"]);
  const items = buildItems(rows);
  assert.equal(items[0].kind === "text" && items[0].text, "旧记录");
  assert.equal(items[0].kind === "text" && items[0].context, undefined);
});

/*
  **「第 2+ 次出现」只有条目这一层算得出来。** 解析器按字节增量读，回读单行时连会话上下文
  都没有——同一条记录会在流式和回读两条路上得出不同的 `update`。数据自己带了答案的
  （`isInitial`）以数据为准，没带的按已加载的这段里的出现顺序补。
*/
test("update is filled in from the sequence only when the payload did not answer it", () => {
  const snapshot = (n: number): MessagePart => ({
    type: "context", text: `prompt ${n}`,
    context: { kind: "prompt_snapshot", tier: "collapsed", length: 8, source: { form: "system_prompt" } },
  });
  const catalog = (update?: boolean): MessagePart => ({
    type: "context", text: "- a: x",
    context: { kind: "skill_listing", tier: "collapsed", length: 6,
      source: { form: "catalog", entries: [{ name: "a", description: "x" }], ...(update === undefined ? {} : { update }) } },
  });
  const items = buildItems(groupMessages([
    msg("context", "", [snapshot(1)]),
    msg("context", "", [snapshot(2)]),
    // 数据说这是第一次，即使它在序列里排第二也不许被改写。
    msg("context", "", [catalog()]),
    msg("context", "", [catalog(false)]),
  ]));
  const update = (i: number) => {
    const item = items[i];
    const source = item.kind === "text" ? item.context?.source : undefined;
    return source && (source.form === "system_prompt" || source.form === "catalog") ? source.update : undefined;
  };
  assert.deepEqual([update(0), update(1)], [false, true], "同一种注入第二次出现就是更新");
  assert.deepEqual([update(2), update(3)], [false, false], "数据里有 isInitial 的以数据为准");
});

/* `source` 缺席是正常情况（表里没有的类型、凑不齐的载荷），那时正文仍然是完整的。 */
test("a context injection without structured source still carries its full text", () => {
  const items = buildItems(groupMessages([
    msg("context", "", [ctxPart("auto_mode", "bashFirst: true")]),
  ]));
  assert.equal(items[0].kind === "text" && items[0].context?.source, undefined);
  assert.equal(items[0].kind === "text" && items[0].text, "bashFirst: true");
});
