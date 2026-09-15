import { test } from "node:test";
import assert from "node:assert/strict";
import { buildItems, groupMessages } from "../src/features/conversations/parts.ts";
import { collectTurnStats, turnStatsByItemKey } from "../src/features/conversations/turn-usage.ts";
import type { HistoryMessage, MessagePart, MessageUsage } from "../src/shared/api/conversationPayloads.ts";

let seq = 0;
type Options = { parts?: MessagePart[]; usage?: MessageUsage; createdAt?: number };
const msg = (role: string, content: string, options: Options = {}): HistoryMessage => {
  seq += 1;
  return {
    messageId: `m${seq}`, historySeq: seq, bodyState: "stored", sourceRevision: 1,
    event: {
      eventId: `e${seq}`, role, content,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...(options.parts || options.usage
        ? { data: { ...(options.parts ? { parts: options.parts } : {}), ...(options.usage ? { usage: options.usage } : {}) } }
        : {}),
    },
  };
};
const stats = (messages: HistoryMessage[], provider?: string) =>
  collectTurnStats(buildItems(groupMessages(messages)), provider);

/* 一条消息的回合：桶原样带过来，总数是四项相加。 */
test("a one-message turn carries the buckets through and totals the four of them", () => {
  const [turn] = stats([
    msg("user", "跑一下测试"),
    msg("assistant", "好的", {
      usage: { inputTokens: 2, outputTokens: 300, cacheReadTokens: 20_000, cacheWriteTokens: 1_500 },
    }),
  ]);
  assert.deepEqual(turn.usage, {
    uncachedInputTokens: 2, outputTokens: 300, cacheReadTokens: 20_000, cacheWriteTokens: 1_500,
    totalTokens: 2 + 300 + 20_000 + 1_500,
  });
});

/* 多条消息：每个桶各自相加。 */
test("a multi-message turn sums every bucket", () => {
  const [turn] = stats([
    msg("user", "改一下"),
    msg("assistant", "先看看", { usage: { inputTokens: 2, outputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 40 } }),
    msg("assistant", "改好了", { usage: { inputTokens: 5, outputTokens: 250, cacheReadTokens: 3_000, cacheWriteTokens: 60 } }),
  ]);
  assert.deepEqual(turn.usage, {
    uncachedInputTokens: 7, outputTokens: 350, cacheReadTokens: 4_000, cacheWriteTokens: 100,
    totalTokens: 7 + 350 + 4_000 + 100,
  });
});

/*
  **桶不全就整个不给那个桶。** 一个回合里只要有一条消息没上报某个桶，整个回合的那个桶就不出现,
  而不是把缺席当 0 加进去——写成 0，界面会说「这次没缓存命中」，而真相是没报。
*/
test("a bucket missing on one message disappears from the whole turn", () => {
  const [turn] = stats([
    msg("user", "继续"),
    msg("assistant", "第一步", { usage: { inputTokens: 2, outputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 40, reasoningTokens: 30 } }),
    /* 这一条只缺 cacheRead 和 reasoning，cacheWrite 照常有。 */
    msg("assistant", "第二步", { usage: { inputTokens: 3, outputTokens: 200, cacheWriteTokens: 60 } }),
  ]);
  assert.equal(turn.usage?.cacheReadTokens, undefined, "缺席的桶整个不出现");
  assert.equal(turn.usage?.reasoningTokens, undefined, "思考缺席也一样，不能当「这次没思考」");
  assert.equal(turn.usage?.cacheWriteTokens, 100, "两条都报了的桶照常给");
  assert.ok(!("cacheReadTokens" in turn.usage!), "不是给一个 undefined，是这个键不存在");
  /* 总数照旧把**上报过的**那 1000 算进去：桶的分项消失，不等于那些 token 没烧。 */
  assert.equal(turn.usage?.totalTokens, 2 + 100 + 1_000 + 40 + (3 + 200 + 60));
});

/* `reasoningTokens` 是 `outputTokens` 的子集，不另加——加了就把思考那部分数了两遍。 */
test("reasoning tokens are a subset of output and never added to the total", () => {
  const [turn] = stats([
    msg("user", "想一想"),
    msg("assistant", "想完了", { usage: { inputTokens: 10, outputTokens: 500, reasoningTokens: 400 } }),
  ]);
  assert.equal(turn.usage?.reasoningTokens, 400);
  assert.equal(turn.usage?.totalTokens, 510, "总数只有输入加输出，思考已经在输出里了");
});

/* 完全没有用量的回合返回 null，而不是一份全零——「没发生过」和「烧了 0 个 token」不一样。 */
test("a turn with no usage at all is null, not a pile of zeroes", () => {
  const [turn] = stats([
    msg("user", "在吗"),
    msg("assistant", "在"),
  ]);
  assert.equal(turn.usage, null);
});

/* 只有一条消息、而且它的 usage 是 undefined：同样是 null。 */
test("a lone message without usage yields null", () => {
  const turns = stats([msg("user", "只有这一句")]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].usage, null);
  assert.equal(turns[0].runMs, null, "一个时刻量不出一段时间");
});

/*
  **同一条消息会摊成好几个条目**：正文一条、工具组一条、带 diff 的工具各自一条。
  按条目求和会把同一次请求的用量数好几遍，所以要按 messageId 去重。
*/
test("one message split across several items is counted once", () => {
  const messages = [
    msg("user", "改三个文件"),
    msg("assistant", "开始", {
      usage: { inputTokens: 4, outputTokens: 900 },
      parts: [
        { type: "text", text: "开始" },
        { type: "tool_call", name: "Read", toolCallId: "c1", text: "Read: a.ts" },
        { type: "tool_call", name: "Read", toolCallId: "c2", text: "Read: b.ts" },
        { type: "tool_call", name: "Read", toolCallId: "c3", text: "Read: c.ts" },
      ],
    }),
    msg("user", "", { parts: [
      { type: "tool_result", toolCallId: "c1", text: "ok" },
      { type: "tool_result", toolCallId: "c2", text: "ok" },
      { type: "tool_result", toolCallId: "c3", text: "ok" },
    ] }),
  ];
  const items = buildItems(groupMessages(messages));
  assert.ok(items.length > 1, "这条消息确实摊成了不止一个条目");
  const [turn] = collectTurnStats(items);
  assert.equal(turn.usage?.outputTokens, 900, "一次请求只能算一次");
  assert.equal(turn.usage?.totalTokens, 904);
});

/* 回合边界照 `buildItems` 标的 `turnStart` 走，不重新判定。 */
test("turns split on turnStart and each keeps its own usage", () => {
  const turns = stats([
    msg("user", "第一问"),
    msg("assistant", "第一答", { usage: { inputTokens: 1, outputTokens: 10 } }),
    msg("user", "第二问"),
    msg("assistant", "第二答", { usage: { inputTokens: 2, outputTokens: 20 } }),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].usage?.outputTokens, 10);
  assert.equal(turns[1].usage?.outputTokens, 20);
  assert.notEqual(turns[0].turnKey, turns[1].turnKey);
});

/*
  第一条用户发言之前的条目（历史被截断、或者从中间拉起来的对话）归进一个空 key 的隐式回合。
  **不丢掉**——丢掉等于让那几次请求的用量凭空消失。
*/
test("items before the first user turn fall into one implicit turn", () => {
  const turns = stats([
    msg("assistant", "接着上面说", { usage: { inputTokens: 1, outputTokens: 7 } }),
    msg("user", "懂了"),
    msg("assistant", "好", { usage: { inputTokens: 2, outputTokens: 8 } }),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].turnKey, "", "看不到开头的回合没有 turnKey");
  assert.equal(turns[0].usage?.outputTokens, 7);
});

/* 耗时是回合首末消息落盘时刻之差。 */
test("runMs is the span between the turn's first and last stamped message", () => {
  const [turn] = stats([
    msg("user", "跑吧", { createdAt: 1_000 }),
    msg("assistant", "跑完了", { createdAt: 5_500, usage: { inputTokens: 1, outputTokens: 2 } }),
  ]);
  assert.equal(turn.runMs, 4_500);
});

/* 少于两条带时刻就量不出来：返回 null，而不是 0——0 会显示成「耗时 0 秒」，那是编的。 */
test("runMs is null when fewer than two messages carry a timestamp", () => {
  const [turn] = stats([
    msg("user", "问", { createdAt: 1_000 }),
    msg("assistant", "答"),
  ]);
  assert.equal(turn.runMs, null);
});

/* 中间那条缺时刻不影响：拿得到的最早和最晚仍然是一段真实的时间（只是可能偏短）。 */
test("a message missing createdAt does not poison the span", () => {
  const [turn] = stats([
    msg("user", "问", { createdAt: 1_000 }),
    msg("assistant", "中间", {}),
    msg("assistant", "答", { createdAt: 9_000 }),
  ]);
  assert.equal(turn.runMs, 8_000);
});

/* 时钟回拨、乱序写入不许折出一个负的耗时。 */
test("out-of-order timestamps never produce a negative runMs", () => {
  const [turn] = stats([
    msg("user", "问", { createdAt: 9_000 }),
    msg("assistant", "答", { createdAt: 1_000 }),
  ]);
  assert.equal(turn.runMs, 8_000);
});

/*
  `routes` 要 provider 和 model 两样。记录上只有 model，provider 是「这段对话用的哪个 CLI」，
  只有调用方知道——**不给就不猜**。
*/
test("routes need both a caller-supplied provider and a model on every attempt", () => {
  const messages = [
    msg("user", "问"),
    msg("assistant", "答一", { usage: { inputTokens: 1, outputTokens: 2, model: "claude-opus-4" } }),
    msg("assistant", "答二", { usage: { inputTokens: 1, outputTokens: 2, model: "claude-opus-4" } }),
  ];
  const withProvider = collectTurnStats(buildItems(groupMessages(messages)), "claude");
  assert.deepEqual(withProvider[0].usage?.routes, [{ provider: "claude", model: "claude-opus-4" }],
    "同一个模型只列一次");
  assert.equal(collectTurnStats(buildItems(groupMessages(messages)))[0].usage?.routes, undefined,
    "没给 provider 就不给 routes，不拿空串拼出一个 /claude-opus-4");
});

test("a turn where one attempt reported no model gets no routes at all", () => {
  const [turn] = stats([
    msg("user", "问"),
    msg("assistant", "答一", { usage: { inputTokens: 1, outputTokens: 2, model: "claude-opus-4" } }),
    msg("assistant", "答二", { usage: { inputTokens: 1, outputTokens: 2 } }),
  ], "claude");
  assert.equal(turn.usage?.routes, undefined, "和三个桶同一条规矩：不全就整个不给");
});

/* 挂在哪一条上是渲染那边的事，这一层给一张覆盖全部条目的表。 */
test("every item key in a turn looks up that turn's stats", () => {
  const items = buildItems(groupMessages([
    msg("user", "问", { createdAt: 1_000 }),
    msg("assistant", "答", { createdAt: 2_000, usage: { inputTokens: 1, outputTokens: 2 } }),
  ]));
  const byKey = turnStatsByItemKey(items);
  assert.equal(byKey.size, items.length);
  const first = byKey.get(items[0].key);
  assert.equal(first?.usage?.totalTokens, 3);
  for (const item of items) assert.equal(byKey.get(item.key), first, "同一个回合里查到的是同一份");
});
