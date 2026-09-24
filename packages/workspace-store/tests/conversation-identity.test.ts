import assert from "node:assert/strict";
import test from "node:test";
import { deriveTitle, titleWins, TITLE_RANK } from "../src/conversation-identity.ts";

/*
  从第一条用户消息推标题。

  它要替掉的是 `claude 3749983a-1594-47` 这种——那种名字在目录里长得一模一样，
  认不出哪条是哪条。实测这台机器 21 条对话里有 14 条是这个样子。
*/
test("短消息原样当标题", () => {
  assert.equal(deriveTitle("看看当前的项目"), "看看当前的项目");
});

test("换行和连续空白压成一个空格", () => {
  /*
    第一条消息经常是粘进去的一整段（报错、日志、代码）。原样截断会把一行标题撑成三行，
    而那三行里没有一行说清了这是什么。
  */
  assert.equal(deriveTitle("第一行\n\n  第二行   第三行"), "第一行 第二行 第三行");
});

test("开头的围栏和引用符去掉——它们不带信息", () => {
  assert.equal(deriveTitle("> 引用的一句话"), "引用的一句话");
  assert.equal(deriveTitle("### 标题式的开头"), "标题式的开头");
  assert.equal(deriveTitle("```\ncode\n```"), "code ```");
});

test("整条都是符号时退回原文,不返回空标题", () => {
  // 去符号之后什么都不剩的话,一个空标题比一串符号更糟——目录里那一行会是空的。
  assert.equal(deriveTitle("###"), "###");
  assert.equal(deriveTitle(">>> "), ">>>");
});

test("超长的截断,并尽量落在词或标点边界上", () => {
  const long = "帮我看一下这个问题，它出现在启动的时候，具体表现是页面白屏而且控制台没有任何报错信息可以参考";
  const title = deriveTitle(long, 30);
  assert.ok(title!.length <= 31, `实际 ${title!.length}`);
  assert.ok(title!.endsWith("…"));
  assert.ok(long.startsWith(title!.slice(0, -1).trimEnd()), "截出来的必须是原文的前缀");
});

test("边界太靠前时宁可硬截——中文本来就没有空格", () => {
  // 一个 60 字的中文句子里可能一个空格都没有,为了找边界把标题砍掉一半更糟。
  const title = deriveTitle("啊".repeat(100), 20);
  assert.equal(title, "啊".repeat(20) + "…");
});

test("没有第一条用户消息时给 null,不造一个标题", () => {
  for (const value of [null, undefined, "", "   ", "\n\n"]) assert.equal(deriveTitle(value), null);
});

/*
  来源的优先级。这一组管的是「谁能盖掉谁」，而每一条错法都会造成实际损害。
*/
test("人自己起的名字不能被任何自动来源盖掉", () => {
  for (const origin of ["fallback", "derived", "native"] as const) {
    assert.equal(titleWins(origin, "user"), false, origin);
  }
});

test("终端的名字能盖掉推导出来的", () => {
  /*
    终端标题和对话标题要统一，是明确要过的行为：人给终端起了名字，对话就该跟着叫那个。
    推导出来的只是一个有信息的默认名，不该挡住它。
  */
  assert.equal(titleWins("native", "derived"), true);
  assert.equal(titleWins("derived", "native"), false);
});

test("同级要允许覆盖,否则终端改名之后对话标题跟不上", () => {
  // 写成严格大于就会出现这个 bug：终端从 A 改名成 B，对话还叫 A。
  assert.equal(titleWins("native", "native"), true);
  assert.equal(titleWins("user", "user"), true);
});

test("兜底值谁都能盖掉", () => {
  assert.equal(titleWins("derived", "fallback"), true);
  assert.equal(TITLE_RANK.fallback < TITLE_RANK.derived, true);
});
