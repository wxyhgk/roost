import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyList, reduceList, type ListState } from "../src/features/conversations/list.ts";
import type { Conversation } from "../src/shared/api/conversations.ts";

const item = (id: string): Conversation => ({
  id, title: "t" + id, titleOrigin: "native", projectId: null,
  createdAt: 1, updatedAt: 1, lastMessageAt: 1, archivedAt: null, trashedAt: null, pinnedAt: null,
  revision: 1, forkedFromId: null,
  source: { id: "s" + id, conversationId: id, legacyConversationId: "l" + id, cliId: "omp",
    nativeSessionId: "n" + id, cwd: null, transcriptPath: null, observedAt: 1 },
});
const loaded = (): ListState =>
  reduceList(emptyList(), { type: "page", items: [item("a"), item("b")], nextCursor: "cur1", append: false });

test("翻页把新一页接在后面，游标跟着走", () => {
  const first = loaded();
  assert.deepEqual(first.items.map(i => i.id), ["a", "b"]);
  assert.equal(first.cursor, "cur1");
  assert.equal(first.done, false);

  const second = reduceList(first, { type: "page", items: [item("c")], nextCursor: null, append: true });
  assert.deepEqual(second.items.map(i => i.id), ["a", "b", "c"]);
  // null 游标既可能是「还没开始」也可能是「到底了」，所以单独记 done。
  assert.equal(second.cursor, null);
  assert.equal(second.done, true);
});

test("筛选条件一变，游标和已加载条目必须一起丢掉", () => {
  const before = loaded();
  const after = reduceList(before, { type: "filter", filters: { q: "报错" } });
  // 后端把筛选条件哈希进游标的 scope，拿旧游标配新条件会被判 400。
  assert.equal(after.cursor, null, "旧游标必须丢掉");
  assert.deepEqual(after.items, [], "旧条目属于旧条件，留着就是错的");
  assert.equal(after.done, false);
  assert.equal(after.loading, true);
  assert.deepEqual(after.filters, { q: "报错" });
});

test("条件没变则原样返回，避免输入框每敲一下列表就闪", () => {
  const before = reduceList(emptyList({ q: "x" }), { type: "page", items: [item("a")], nextCursor: "c", append: false });
  assert.equal(reduceList(before, { type: "filter", filters: { q: "x" } }), before);
  // 默认值和显式值等价：state 不写就是 active。
  assert.equal(reduceList(before, { type: "filter", filters: { q: "x", state: "active" } }), before);
  // 真的变了才重置。
  assert.notEqual(reduceList(before, { type: "filter", filters: { q: "x", state: "archived" } }), before);
});

test("失败保留已加载内容，只记错误", () => {
  const before = loaded();
  const failed = reduceList(before, { type: "failed", message: "网络错误" });
  assert.deepEqual(failed.items.map(i => i.id), ["a", "b"], "已读到的历史不该因为下一页失败就消失");
  assert.equal(failed.error, "网络错误");
  assert.equal(failed.loading, false);
  // 重试时清掉上一次的错误，不要两条错误叠着显示。
  assert.equal(reduceList(failed, { type: "loading" }).error, null);
});

/*
  **改完之后列表里那一行要换掉。**

  复现过的那条路：目录里点开一条 → 改标题 → 返回列表 → 标题还是旧的 → 再点同一行，
  详情拿到的是列表里那个对象，它带着**旧 revision** → 下一次改任何一项都先撞一次 409
  「别处刚改过」，而「别处」就是自己刚才。所以这里换的不只是标题，更是 revision。
*/
test("详情里改完，列表里那一行换成新记录（含新 revision）", () => {
  const before = loaded();
  const renamed: Conversation = { ...item("b"), title: "改过的标题", revision: 2 };
  const after = reduceList(before, { type: "replace", conversation: renamed });
  assert.deepEqual(after.items.map(i => i.id), ["a", "b"], "位置不动——行在用户刚点过的地方跳走更糟");
  assert.equal(after.items[1].title, "改过的标题");
  assert.equal(after.items[1].revision, 2, "旧 revision 留着就是下一次 409 的来源");
  assert.equal(after.items[0].title, "ta", "别的行一个字都不该动");
  // 翻页状态和这件事无关，不能被顺手重置掉。
  assert.equal(after.cursor, "cur1");
});

test("列表里没有这一行就什么都不做，不往筛过的列表里插一条", () => {
  const before = loaded();
  const stranger: Conversation = { ...item("zzz"), title: "不在这一页里" };
  const after = reduceList(before, { type: "replace", conversation: stranger });
  assert.equal(after, before, "原样返回：它可能压根不匹配当前筛选条件");
});
