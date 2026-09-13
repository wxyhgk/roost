import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyHistory, historyOnReload, isLongReply, mergeMessages, messageIdsFromChanges, type HistoryMessage } from "../src/features/conversations/history.ts";

const msg = (id: string, seq: number, revision = 1, content = "c" + id): HistoryMessage =>
  ({ messageId: id, historySeq: seq, sourceRevision: revision, bodyState: "stored", event: { role: "assistant", content } });

test("合并按 historySeq 升序，往回翻的更早消息接到前面", () => {
  const latest = mergeMessages([], [msg("c", 3), msg("d", 4)]);
  const withOlder = mergeMessages(latest, [msg("a", 1), msg("b", 2)]);
  assert.deepEqual(withOlder.map(m => m.messageId), ["a", "b", "c", "d"]);
});

test("同一条消息送达多次不会重复显示", () => {
  const once = mergeMessages([], [msg("a", 1)]);
  const twice = mergeMessages(once, [msg("a", 1)]);
  assert.equal(twice.length, 1);
  // 内容和版本都没变时连数组都不该换，免得白白重渲染。
  assert.equal(twice, once);
});

test("版本更大的覆盖旧的；迟到的旧版本必须丢弃", () => {
  const preview = mergeMessages([], [msg("a", 1, 1, "截断的预览…")]);
  const full = mergeMessages(preview, [msg("a", 1, 2, "补全之后的完整正文")]);
  assert.equal(full[0]!.event.content, "补全之后的完整正文");
  assert.equal(full[0]!.sourceRevision, 2);

  // 这条是关键：网络乱序时旧版本可能后到，覆盖回去就等于把正文又截断了。
  const stale = mergeMessages(full, [msg("a", 1, 1, "截断的预览…")]);
  assert.equal(stale[0]!.event.content, "补全之后的完整正文", "迟到的旧版本不得覆盖新版本");
  assert.equal(stale, full, "什么都没变，数组也不该换");
});

test("版本相同但正文变了，采用后到的那份", () => {
  // 回读拿到的正文比快照里的预览完整，而两者的 sourceRevision 可能一样。
  const preview = mergeMessages([], [msg("a", 1, 3, "预览")]);
  const reread = mergeMessages(preview, [msg("a", 1, 3, "回读到的完整正文")]);
  assert.equal(reread[0]!.event.content, "回读到的完整正文");
});

test("只有消息类变更需要回读正文，其余种类不混进来", () => {
  const ids = messageIdsFromChanges([
    { kind: "history.message.updated", entityId: "m1" },
    { kind: "history.body.updated", entityId: "m2" },
    { kind: "history.message.updated", entityId: "m1" },
    { kind: "conversation.updated", entityId: "conv" },
    { kind: "run.updated", entityId: "run" },
    { kind: "peer.delivery.updated", entityId: "d1" },
  ]);
  assert.deepEqual(ids, ["m1", "m2"], "去重，且不把标题/run/投递当成消息去回读");
});

test("只有真的长的 AI 回复才折叠，短的不该冒出一个没用的展开按钮", () => {
  assert.equal(isLongReply("好的"), false);
  assert.equal(isLongReply("一\n二\n三\n四"), false, "四行以内直接铺开");
  assert.equal(isLongReply("一\n二\n三\n四\n五"), true, "超过四行才折叠");
  assert.equal(isLongReply("x".repeat(240)), false);
  // 单行也可能很长：只看行数会漏掉这一半。
  assert.equal(isLongReply("x".repeat(241)), true, "超长单行同样要折叠");
});


/*
  **两种重取长得一样，结论相反。** 网关重启换 epoch 是重取同一段对话，屏幕上那份留着能
  避免闪空；换了对话对象还留着，就是把上一段的消息显示在新对话里——用户会读到不属于这里
  的内容，比空白糟得多。
*/
test("reloading the same conversation keeps the screen, switching conversations does not", () => {
  const previous = { ...emptyHistory, items: [{ messageId: "m1", historySeq: 1, bodyState: "stored",
    sourceRevision: 1, event: { eventId: "e1", role: "user", content: "上一段的话" } }] };
  assert.equal(historyOnReload(previous, true), previous, "同一段：留着，别闪空");
  assert.deepEqual(historyOnReload(previous, false), emptyHistory, "换了对话：不能显示上一段的内容");
});
