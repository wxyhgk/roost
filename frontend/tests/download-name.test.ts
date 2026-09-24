import assert from "node:assert/strict";
import { test } from "node:test";
import { safeDownloadName } from "../src/shared/download.ts";

/*
  文件名洗不干净的后果是下载被浏览器拒掉、或者名字被改得面目全非。

  仓库里原来有四份下载实现，**只有一份洗了名字**——另外三份里，`exportJson` 拿的是
  i18n 里的固定文案（安全），但分子编辑器那份是从路径末段来的、文件树那份直接用
  `node.name`，两者都可能带非法字符。
*/
test("路径分隔符和 Windows 保留字符换成短横", () => {
  assert.equal(safeDownloadName('a/b\\c:d*e?f"g<h>i|j.txt'), "a-b-c-d-e-f-g-h-i-j.txt");
});

test("控制字符也要洗——它们在文件名里既不可见又能让保存失败", () => {
  assert.equal(safeDownloadName("a\u0000b\nc.txt"), "a-b-c.txt");
});

test("开头的点去掉——`.bashrc` 那种下载下来是隐藏文件,人会以为没存上", () => {
  assert.equal(safeDownloadName("...hidden.txt"), "hidden.txt");
  // 中间和结尾的点是正常的扩展名分隔，不动。
  assert.equal(safeDownloadName("a.b.txt"), "a.b.txt");
});

test("截到 120 个字符", () => {
  /*
    按字符不按字节：各平台上限不一样（多数 255 字节），而中文一个字三字节。
    留出余量比精确算简单，也不会有人真需要一个 200 字的文件名。
  */
  assert.equal(safeDownloadName("啊".repeat(300)).length, 120);
  assert.equal(safeDownloadName("a".repeat(50)).length, 50, "没超就别动它");
});

test("洗完什么都不剩时用兜底名", () => {
  /*
    空的 `download` 属性等于没设，浏览器会拿 URL 的最后一段当文件名——blob URL 的最后
    一段是一串随机 uuid。给个名字比给一串 uuid 强。
  */
  assert.equal(safeDownloadName("///"), "download");
  assert.equal(safeDownloadName("   "), "download");
  assert.equal(safeDownloadName("...", "terminal.log"), "terminal.log");
});

test("正常名字原样通过", () => {
  for (const name of ["notes.json", "会话记录.log", "a-b_c (2).txt"]) {
    assert.equal(safeDownloadName(name), name);
  }
});
