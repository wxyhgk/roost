import assert from "node:assert/strict";
import { test } from "node:test";
import { isExternalHref, resolveDocPath } from "../src/plugins/markdown/markdownPaths.ts";

test("相对路径按文档所在目录解析，`..` 是合法写法", () => {
  const doc = "tasks/notes/plan.md";
  assert.equal(resolveDocPath(doc, "./a.png"), "tasks/notes/a.png");
  assert.equal(resolveDocPath(doc, "a.png"), "tasks/notes/a.png");
  assert.equal(resolveDocPath(doc, "sub/b.png"), "tasks/notes/sub/b.png");
  // 这正是不能复用 resolveLinkTarget 的原因：那个一律拒绝 `..`，
  // 而文档引用上级目录的图片是日常写法。
  assert.equal(resolveDocPath(doc, "../other.md"), "tasks/other.md");
  assert.equal(resolveDocPath(doc, "../../README.md"), "README.md");
  // 以 / 开头按「相对于根目录」理解，文档里没有文件系统绝对路径的语义。
  assert.equal(resolveDocPath(doc, "/tasks/x.md"), "tasks/x.md");
  // 根目录下的文档。
  assert.equal(resolveDocPath("README.md", "./docs/a.md"), "docs/a.md");
});

test("越出根目录一律拒绝，宁可不渲染成链接", () => {
  assert.equal(resolveDocPath("tasks/plan.md", "../../etc/passwd"), null);
  assert.equal(resolveDocPath("README.md", "../outside.md"), null);
  assert.equal(resolveDocPath("a/b/c.md", "../../../../x"), null);
  // 解析后为空才是无意义的（根目录文档指向根本身）。
  assert.equal(resolveDocPath("README.md", "."), null);
  assert.equal(resolveDocPath("tasks/plan.md", ""), null);
});

test("指向目录的链接如实解析成目录路径，由调用方处理", () => {
  // `.` 就是文档所在目录，这是正确解析而不是失败。指向目录的链接在
  // markdown 里少见但合法；打开它会得到一个预览错误，那是诚实的反馈。
  assert.equal(resolveDocPath("tasks/plan.md", "."), "tasks");
  assert.equal(resolveDocPath("tasks/plan.md", "./"), "tasks");
  assert.equal(resolveDocPath("tasks/plan.md", "../research/"), "research");
});

test("锚点与查询串不参与路径解析", () => {
  const doc = "tasks/plan.md";
  assert.equal(resolveDocPath(doc, "./other.md#section"), "tasks/other.md");
  assert.equal(resolveDocPath(doc, "./other.md?v=2"), "tasks/other.md");
  // 纯锚点是文档内跳转，不是文件。
  assert.equal(resolveDocPath(doc, "#section"), null);
});

test("协议链接与协议相对链接不当作仓库内路径", () => {
  for (const href of ["https://example.com", "http://a.b", "mailto:a@b.c", "//cdn.example.com/x.png", "data:text/plain,hi"]) {
    assert.equal(isExternalHref(href), true, href);
    assert.equal(resolveDocPath("a.md", href), null, href);
  }
  for (const href of ["./a.png", "../b.md", "/c.md", "d/e.png"]) {
    assert.equal(isExternalHref(href), false, href);
  }
  // 纯锚点算「不是仓库内路径」，交给浏览器自己滚动。
  assert.equal(isExternalHref("#top"), true);
});
