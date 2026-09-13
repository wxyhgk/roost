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
