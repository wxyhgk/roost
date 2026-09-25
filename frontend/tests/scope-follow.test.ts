/*
  范围跟着当前终端走。

  这套测试盯的是**两类相反的错**：该跟随却没跟随（侧栏高亮说谎、画布看不到正在用的终端、
  新建终端掉进已经离开的分组），以及不该跟随却跟随了（「全部终端」这个视角被一次点击收窄）。
*/
import { equal } from "node:assert/strict";
import { test } from "node:test";
import { scopeFollowingSession } from "../src/shared/view";

test("停在某个分组时，选另一个分组里的终端会跟过去", () => {
  equal(scopeFollowingSession("group-a", "group-b"), "group-b");
});

test("停在「未分组」时也跟随——它和具体分组一样是个筛过的视角", () => {
  equal(scopeFollowingSession(null, "group-b"), "group-b");
});

test("选中的终端本来就没分组，范围落到「未分组」", () => {
  equal(scopeFollowingSession("group-a", null), null);
});

test("「全部终端」不跟随：那是主动选的「不筛」，点个终端就收窄等于抢方向盘", () => {
  equal(scopeFollowingSession("all", "group-b"), "all");
  equal(scopeFollowingSession("all", null), "all");
});

test("终端不在列表里（还没同步到、或刚被关掉）时不动——不知道该去哪就别动", () => {
  equal(scopeFollowingSession("group-a", undefined), "group-a");
  equal(scopeFollowingSession(null, undefined), null);
  equal(scopeFollowingSession("all", undefined), "all");
});

test("本来就一致时原样返回，不会引起一次多余的状态写入", () => {
  equal(scopeFollowingSession("group-a", "group-a"), "group-a");
  equal(scopeFollowingSession(null, null), null);
});
