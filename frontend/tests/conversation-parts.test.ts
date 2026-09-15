import { test } from "node:test";
import assert from "node:assert/strict";
import { groupMessages, type Row } from "../src/features/conversations/parts.ts";
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
