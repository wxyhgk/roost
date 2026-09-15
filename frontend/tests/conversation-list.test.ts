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
  **归档/回收站之后就地移走那一行，不重拉一页。**

  列表按 `state` 筛（默认只列 active），打完标记那一条按定义就不该在这儿。重拉一页会让整列
  闪一下，而且**游标是和筛选条件绑定的**——重拉要么从头开始（丢掉用户已经翻出来的几页），
  要么拿旧游标去请求而后端判 400 "cursor does not match"。就地移走两样都不碰。
*/
test("dropping an archived row keeps the cursor and the rest of the page", () => {
  const before = loaded();
  const after = reduceList(before, { type: "drop", id: "a" });
  assert.deepEqual(after.items.map(i => i.id), ["b"]);
  assert.equal(after.cursor, before.cursor, "游标不能动——少一条不改变还有没有下一页");
  assert.equal(after.done, before.done);
});

/*
  没命中就**原样返回同一个对象**。那一条可能本来就不在当前这一页（用户在别处归档了它），
  换一个新对象等于让整列白渲染一次。
*/
test("dropping an id that is not on this page changes nothing at all", () => {
  const before = loaded();
  assert.equal(reduceList(before, { type: "drop", id: "zzz" }), before);
});
