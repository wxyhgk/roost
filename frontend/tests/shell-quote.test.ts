import assert from "node:assert/strict";
import { test } from "node:test";
import { shellQuote, quoteShellPath } from "../src/shared/shell.ts";

/*
  这一组守的是一件具体的事：**从文件树把一个文件名塞进终端，它必须还是一个文件名，
  不能变成一条命令**。roost 在公网上又有文件上传，所以「文件名是别人起的」不是假设。
*/
test("元字符一律引用——黑名单漏掉的那一批", () => {
  /*
    旧实现的触发字符集只有 `\s " ' ` $ \ !`，下面每一个都漏了，而且漏的后果不一样：
    `;` 和 `&` 让后半段真的执行，`(` 直接是 bash 语法错误。
  */
  for (const name of ["x;id.ts", "a&b.ts", "a|b.ts", "a(b).ts", "a>b.ts", "a<b.ts",
    "a*b.ts", "a?b.ts", "a[b].ts", "a{b}.ts", "a#b.ts", "a\nb.ts"]) {
    const quoted = quoteShellPath(name);
    assert.notEqual(quoted, name, `${JSON.stringify(name)} 必须被引用`);
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), quoted);
  }
});

test("普通路径原样给出——引号不该到处都是", () => {
  // 终端里读起来要干净。这条是「白名单」而不是「一律引用」的全部理由。
  for (const p of ["src/foo.ts", "a-b_c/d.e", "README.md", "/Users/me/Code/x.ts", "a.b@c:d+e,f%g=h"]) {
    assert.equal(quoteShellPath(p), p);
  }
});

test("开头的 - 要引用——它会被当成选项", () => {
  // 不是元字符，但含义不是「这是一个文件名」。中间的 `-` 无所谓。
  assert.equal(quoteShellPath("-rf"), "'-rf'");
  assert.equal(quoteShellPath("a-b.ts"), "a-b.ts");
});

test("含 ~ 的一律引用,不只是开头那个", () => {
  /*
    波浪号展开主要在词首，但 `:` 后面也会（`PATH=a:~/b` 那一类），而白名单里恰好有 `:`。
    与其分辨哪些位置安全，不如让任何含 `~` 的都走引用。
  */
  assert.equal(quoteShellPath("~/secret"), "'~/secret'");
  assert.equal(quoteShellPath("a:~/b"), "'a:~/b'");
  assert.equal(quoteShellPath("a~b.ts"), "'a~b.ts'");
});

test("非 ASCII 一律引用", () => {
  /*
    中文文件名在 shell 里其实没有特殊含义，但把它们放进白名单就得回答「哪些 Unicode
    码位是安全的」，那是个没有尽头的问题。多一对引号没有任何代价。
  */
  assert.equal(quoteShellPath("正常文件.ts"), "'正常文件.ts'");
});

test("单引号自己也要能引用", () => {
  // `'` → `'"'"'`：收尾、用双引号包一个字面单引号、再开头。
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
  assert.equal(shellQuote("'"), `''"'"''`);
});

test("空串变成一个空参数,不是消失", () => {
  // `''` 在 shell 里是「一个空参数」；直接给空串则等于什么都没传。
  assert.equal(shellQuote(""), "''");
  assert.equal(quoteShellPath(""), "''");
});

test("引用之后再也没有未转义的单引号", () => {
  /*
    这条是上面所有断言的通用形式：把引用结果按单引号切开，奇数段必须全是被 `"` 包住的
    那个字面单引号。比逐个字符列举更难骗过去。
  */
  for (const raw of ["a'b", "';id;'", "a\\'b", "''", "x'''y"]) {
    const quoted = shellQuote(raw);
    assert.ok(/^'([^']|'"'"')*'$/.test(quoted), `${raw} → ${quoted}`);
  }
});
