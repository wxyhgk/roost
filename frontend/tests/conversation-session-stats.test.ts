import { test } from "node:test";
import assert from "node:assert/strict";
import { buildItems, groupMessages } from "../src/features/conversations/parts.ts";
import { collectSessionStats } from "../src/features/conversations/turn-usage.ts";
import type { HistoryMessage, MessagePart, MessageUsage } from "../src/shared/api/conversationPayloads.ts";

/*
  会话级的折算（输入卡下面那两颗药丸）。和回合级用同一套构造器，因为要钉的正是
  「同一批记录、换一个求和边界」这件事。

  纯 TS、不带 JSX：`node --test` 加载不了 CSS Module，判定跟着组件进去就一条都测不到。
*/

let seq = 0;
type Options = { parts?: MessagePart[]; usage?: MessageUsage };
const msg = (role: string, content: string, options: Options = {}): HistoryMessage => {
  seq += 1;
  return {
    messageId: `m${seq}`, historySeq: seq, bodyState: "stored", sourceRevision: 1,
    event: {
      eventId: `e${seq}`, role, content,
      ...(options.parts || options.usage
        ? { data: { ...(options.parts ? { parts: options.parts } : {}), ...(options.usage ? { usage: options.usage } : {}) } }
        : {}),
    },
  };
};
/*
  **两个入参喂的是两个总体**：条目只用来数回合边界，用量和步数走原始记录。
  分开不是冗余——`buildItems` 把跨消息的连续工具调用收成一组，而那一组只记住第一条消息，
  于是后面几条的 `usage` 在条目层面就不见了（下面有一条专门钉这件事的用例）。
*/
const session = (messages: HistoryMessage[]) =>
  collectSessionStats(buildItems(groupMessages(messages)), messages);

/* 最朴素的一段：两个回合、三次请求，四个桶全程有，总数按桶相加。 */
test("a whole session sums every bucket and counts turns and steps", () => {
  const stats = session([
    msg("user", "跑一下测试"),
    msg("assistant", "先看看", { usage: { inputTokens: 2, outputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 40 } }),
    msg("assistant", "好了", { usage: { inputTokens: 3, outputTokens: 200, cacheReadTokens: 2_000, cacheWriteTokens: 60 } }),
    msg("user", "再改一处"),
    msg("assistant", "改好了", { usage: { inputTokens: 5, outputTokens: 300, cacheReadTokens: 4_000, cacheWriteTokens: 100 } }),
  ]);
  assert.equal(stats.turns, 2);
  assert.equal(stats.steps, 3);
  assert.deepEqual(stats.usage, {
    uncachedInputTokens: 10, outputTokens: 600, cacheReadTokens: 7_000, cacheWriteTokens: 200,
  });
});

/*
  **桶缺一个就整份账不给**，而不是像回合级那样只丢那一个桶。`SessionTokenUsage` 四项全是
  必填的，因为弹层里「未缓存输入 / 缓存读取 / 输出」三行无条件画——缺席当 0 就会写出
  一句「缓存读取 0」，而真相是没报。
*/
test("one request missing a bucket drops the whole session account", () => {
  const stats = session([
    msg("user", "继续"),
    msg("assistant", "第一步", { usage: { inputTokens: 2, outputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 40 } }),
    /* 这一条没报缓存读取。 */
    msg("assistant", "第二步", { usage: { inputTokens: 3, outputTokens: 200, cacheWriteTokens: 60 } }),
  ]);
  assert.equal(stats.usage, null);
  /* 轮数和步数是另一回事，照样数得出来——药丸那一行不会整个消失。 */
  assert.equal(stats.turns, 1);
  assert.equal(stats.steps, 2);
});

/*
  **一条 assistant 记录在 buildItems 里会摊成好几个条目**（正文一条、工具组一条、
  带 diff 的调用各一条）。按条目求和会把同一次请求数好几遍，所以用量走的是原始记录。
*/
test("a message split into several items is still one step", () => {
  const usage: MessageUsage = { inputTokens: 2, outputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 40 };
  const stats = session([
    msg("user", "读一下"),
    msg("assistant", "这就读", { usage, parts: [
      { type: "text", text: "这就读" },
      { type: "tool_call", toolCallId: "t1", name: "Read", text: 'Read: {"file_path":"/a.ts"}' },
    ] as MessagePart[] }),
    msg("user", "", { parts: [{ type: "tool_result", toolCallId: "t1", text: "1\tconst a = 1;" }] as MessagePart[] }),
  ]);
  assert.equal(stats.steps, 1);
  assert.deepEqual(stats.usage, {
    uncachedInputTokens: 2, outputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 40,
  });
});

/*
  **一次计费请求都没有：`usage` 是 null，不是一份全零的账。** 轮数和步数照样数得出来
  ——它们是转录本身的属性，和「用量报没报」无关；不上报 usage 的 CLI 走的正是这条路。
*/
test("a session without any billed request still counts turns and steps", () => {
  const stats = session([
    msg("user", "你好"),
    msg("assistant", "你好"),
  ]);
  assert.deepEqual(stats, { turns: 1, steps: 1, usage: null });
});

/*
  **步数不跟着「报没报用量」走。** 一次模型响应就是一步，哪怕它这一条没带 usage——
  用带 usage 的记录数会让不上报的 CLI 步数恒为 0，而那些步是真发生过的。
*/
test("steps count assistant records, not billed ones", () => {
  const stats = session([
    msg("user", "第一句"),
    msg("assistant", "没有 usage 的回答"),
    msg("user", "第二句"),
    msg("assistant", "有 usage 的回答", { usage: { inputTokens: 1, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 } }),
  ]);
  assert.equal(stats.turns, 2);
  assert.equal(stats.steps, 2);
});

/*
  **这一条钉的是踩过的那个坑。** `buildItems` 把连续的工具调用收成一组，而那一组只记住
  第一条消息（`parts.ts` 的 `pendingTools ??= { …, message: row.message }`）——三条各自
  带 usage 的记录被收成一个条目之后，走条目求和只剩下第一条的账。所以用量和步数吃的是
  原始记录，不是条目。

  [实测] 隔离 fixture 里 10 条记录（5 条带 usage）过一遍 `buildItems` 只剩 3 个条目、
  1 条带 usage，会话总量因此从 5 次请求缩成 1 次。
*/
test("tool calls folded into one group still contribute every record's usage", () => {
  const call = (id: string) => ([{ type: "tool_call", toolCallId: id, name: "Read",
    text: `Read: {"file_path":"/${id}.ts"}` }] as MessagePart[]);
  const result = (id: string) => ([{ type: "tool_result", toolCallId: id, text: "ok" }] as MessagePart[]);
  const stats = session([
    msg("user", "读三个文件"),
    msg("assistant", "", { usage: { inputTokens: 1, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 1 }, parts: call("a") }),
    msg("user", "", { parts: result("a") }),
    msg("assistant", "", { usage: { inputTokens: 2, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 2 }, parts: call("b") }),
    msg("user", "", { parts: result("b") }),
    msg("assistant", "", { usage: { inputTokens: 4, outputTokens: 40, cacheReadTokens: 400, cacheWriteTokens: 4 }, parts: call("c") }),
    msg("user", "", { parts: result("c") }),
  ]);
  assert.equal(stats.steps, 3);
  assert.deepEqual(stats.usage, {
    uncachedInputTokens: 7, outputTokens: 70, cacheReadTokens: 700, cacheWriteTokens: 7,
  });
});

/*
  历史被截断时第一条用户发言之前也可能有条目。它们归进 key 为空的隐式回合——**照样算一轮**，
  丢掉等于说「这段对话是从这里开始的」，而那不是真的。
*/
test("items before the first user message still count as a turn", () => {
  const stats = session([
    msg("assistant", "（上半段没保存下来）", { usage: { inputTokens: 7, outputTokens: 70, cacheReadTokens: 700, cacheWriteTokens: 7 } }),
    msg("user", "接着说"),
    msg("assistant", "好", { usage: { inputTokens: 1, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 1 } }),
  ]);
  assert.equal(stats.turns, 2);
  assert.equal(stats.steps, 2);
  assert.deepEqual(stats.usage, {
    uncachedInputTokens: 8, outputTokens: 80, cacheReadTokens: 800, cacheWriteTokens: 8,
  });
});

import { readFileSync } from "node:fs";

/*
  **我们给会话药丸喂了六个 0，而那不是「把未知当成 0 显示」——是靠上游的一条退化路径。**

  `StatsPills` 的 `TimePill` 在「一项计时都没有」时把药丸渲染成一个**不可点的静态读数**，
  不开空弹层。所以传 0 是安全的：`0 when no node carries timing` 就是上游给这些字段写的语义
  （模型用时 / 工具用时 / TTFT / 输出速度我们一项都算不出来，理由同 `turnRunMs`）。

  **但这等于把上游的一个实现细节当成了契约。** 重新同步 vendor 时如果那个闸门变了（比如改成
  「有 turns 就开弹层」），我们的六个 0 立刻会变成界面上四行「0ms」——一句凭空的假话，
  而且 typecheck 和别的测试都看不见。

  闸门是内联在组件里的，抽不出来做纯函数测试（那个文件要保持函数体逐字）。所以这里用
  **锚点断言**：钉住那行条件还在。它一旦不在，这条用例就红，逼下一个人重新决定要不要继续喂 0。
  手法和 `scripts/check-boundaries.mjs` 里那批规则锚点一样。
*/
test("the session time pill still degrades to a static reading when every timing is zero", () => {
  const source = readFileSync(new URL("../src/vendor/dsh/chat/StatsPills.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /stats\.llmMs <= 0 && stats\.toolMs <= 0 && stats\.ttftSteps <= 0 && stats\.decodeMs <= 0/,
    "上游的退化闸门不见了——我们喂的六个 0 会变成界面上四行「0ms」，重新决定要不要继续喂",
  );
});
