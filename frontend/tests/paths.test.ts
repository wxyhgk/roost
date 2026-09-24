import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteShellPath } from "../src/features/terminal/paths.ts";

/*
  这个文件只守「terminal/paths 仍然转发着引用函数」这一件事；引用本身的行为在
  `shell-quote.test.ts` 里逐条测。

  原来这里有一条 `quoteShellPath("as-is (v2).ts")` 的断言，**看上去覆盖了括号，其实是靠
  那个空格才被引用的**——括号本身一直没有被测到，而旧实现恰恰漏了括号。留个记号在这儿。
*/
test("转发的是同一个实现", () => {
  assert.equal(quoteShellPath("src/foo.ts"), "src/foo.ts");
  assert.equal(quoteShellPath("as-is (v2).ts"), "'as-is (v2).ts'");
});
