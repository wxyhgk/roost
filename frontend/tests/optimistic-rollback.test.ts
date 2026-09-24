import assert from "node:assert/strict";
import { test } from "node:test";
import { syncOptimistic } from "../src/shared/store/sync.ts";
import { empty, reducer, type Data } from "../src/shared/store/state.ts";
import type { Action } from "../src/shared/store/state.ts";

const tick = () => new Promise<void>(r => setImmediate(r));

function store(initial: Data = empty) {
  let state = initial;
  return {
    dispatch: (action: Action) => { state = reducer(state, action); },
    get: () => state,
  };
}

const session = { id: "a", title: "旧名", projectId: null, cwd: "/tmp", closed: false };
const seed: Data = { ...empty, sessions: [session], selectedId: "a" };

test("a failed optimistic write rolls back without the network and leaves the reason on screen", async () => {
  const s = store(seed);
  const before = s.get();
  s.dispatch({ type: "patchSession", id: "a", title: "新名" });
  assert.equal(s.get().sessions[0].title, "新名", "the rename shows immediately");

  // The backend being unreachable is the usual reason a write fails, so recovery must not
  // depend on a further request succeeding.
  syncOptimistic(Promise.reject(new Error("offline")), s.dispatch, "重命名会话保存失败，已恢复", before);
  await tick();

  assert.equal(s.get().sessions[0].title, "旧名", "state returns to the pre-write snapshot");
  assert.equal(s.get().error, "重命名会话保存失败，已恢复", "the message survives the rollback");
});

test("a successful optimistic write changes nothing further", async () => {
  const s = store(seed);
  const before = s.get();
  s.dispatch({ type: "patchSession", id: "a", title: "新名" });
  syncOptimistic(Promise.resolve(), s.dispatch, "不该出现", before);
  await tick();
  assert.equal(s.get().sessions[0].title, "新名");
  assert.equal(s.get().error, null);
});

test("回滚会打上「要全量对账」的记号——不然被它抹掉的别的改动永远回不来", async () => {
  /*
    **这是回滚本身的代价，也是这一条存在的全部理由。** 回滚的是整份快照，而首轮之后的
    轮询只发 `patchLive`（只补 cwd/cli/cliId）。所以在这次写发出到它失败之间、由**别的**
    操作成功改到服务端的标题/分组/排序，会被这次回滚一起抹掉，然后再也回不来——只能
    刷新页面，而报的错还是上一个操作的名字。

    下面就照这个顺序演一遍：慢写在飞 → 期间另一个改动落地 → 慢写失败。
  */
  const s = store(seed);
  const before = s.get();
  s.dispatch({ type: "patchSession", id: "a", title: "拖动中的名字" });

  const slow = Promise.reject(new Error("offline"));
  syncOptimistic(slow, s.dispatch, "分组排序保存失败，已恢复", before);

  // 这一笔成功了，服务端已经存下「另一个操作改的名」。
  s.dispatch({ type: "patchSession", id: "a", title: "另一个操作改的名" });
  await tick();

  assert.equal(s.get().sessions[0].title, "旧名", "回滚照旧——本地不该显示成存上了");
  assert.equal(s.get().needsFullRead, true,
    "但必须留下记号：下一次轮询要走全量合并，把服务端那个名字取回来");
});

test("成功的写不打记号——否则每写一次都要全量拉一遍", async () => {
  const s = store(seed);
  const before = s.get();
  s.dispatch({ type: "patchSession", id: "a", title: "新名" });
  syncOptimistic(Promise.resolve(), s.dispatch, "不该出现", before);
  await tick();
  assert.equal(s.get().needsFullRead, undefined);
});
