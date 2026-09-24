import assert from "node:assert/strict";
import { test } from "node:test";
import { renameTarget } from "../src/features/files/rename.ts";

/*
  改名的目标路径。

  这几条以前长在 `TreeNode.commitRename` 里，只能靠手点去试——而它的错法全是不报错的：
  前缀切错就是静悄悄地把文件**移**到别的目录，名字里带 `/` 也一样。所以照
  `features/windows/geometry.ts` 的做法抽成纯函数逐条钉住。
*/

test("只换最后一段，前面那串原样带着", () => {
  assert.equal(renameTarget("src/features/a.ts", "b.ts"), "src/features/b.ts");
});

test("顶层条目没有前缀，整条路径就是那一段", () => {
  assert.equal(renameTarget("a.ts", "b.ts"), "b.ts");
});

test("前后空白不算名字的一部分", () => {
  assert.equal(renameTarget("src/a.ts", "  b.ts  "), "src/b.ts");
});

test("空名字、只有空白：什么都不做", () => {
  assert.equal(renameTarget("src/a.ts", ""), null);
  assert.equal(renameTarget("src/a.ts", "   "), null);
});

test("同名不发请求 —— 否则后端把「改成同名」当冲突，回车换来一句「重命名失败」", () => {
  assert.equal(renameTarget("src/a.ts", "a.ts"), null);
  // 去掉空白后同名，也还是同名。
  assert.equal(renameTarget("src/a.ts", " a.ts "), null);
});

test("名字里带 `/` 一律拒绝：那是移动，不该从改名输入框里悄悄发生", () => {
  assert.equal(renameTarget("src/a.ts", "sub/b.ts"), null);
  assert.equal(renameTarget("src/a.ts", "/abs.ts"), null);
  // 这一条是最要紧的：`../` 会穿出当前目录。
  assert.equal(renameTarget("src/a.ts", "../b.ts"), null);
});

test("同名判定看的是路径末段，而不是目录里恰好有同名的上一层", () => {
  // `a` 在两层里都出现：末段是 `a.ts`，改成 `a` 是一次真的改名，不能被判成同名。
  assert.equal(renameTarget("a/a.ts", "a"), "a/a");
});

test("目录也走同一条路（末尾不带斜杠，和 FileNode.path 一致）", () => {
  assert.equal(renameTarget("src/old", "new"), "src/new");
});
