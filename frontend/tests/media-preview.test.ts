import assert from "node:assert/strict";
import { test } from "node:test";
import { rawFileUrl } from "../src/shared/api/index.ts";
import { readFileSync } from "node:fs";
import { audioPlugin, imagePlugin, pdfPlugin, videoPlugin } from "../src/plugins/media/index.tsx";
import { EDITOR_PLUGINS } from "../src/plugins/index.ts";

test("image plugin matches raster/vector extensions but not pdf or text", () => {
  for (const name of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.svg", "a.ico", "a.avif"]) {
    assert.equal(imagePlugin.match(name), true, name);
  }
  for (const name of ["a.pdf", "a.txt", "a.xyz", "png.txt"]) {
    assert.equal(imagePlugin.match(name), false, name);
  }
});

test("pdf plugin matches only pdf", () => {
  assert.equal(pdfPlugin.match("a.pdf"), true);
  assert.equal(pdfPlugin.match("a.PDF"), true);
  assert.equal(pdfPlugin.match("a.png"), false);
  assert.equal(pdfPlugin.match("pdf.txt"), false);
});

test("raw file url encodes root and path", () => {
  const url = rawFileUrl("/tmp/a b", "sub/x.png");
  assert.ok(url.startsWith("/api/file/raw?"), url);
  const q = new URLSearchParams(url.slice("/api/file/raw?".length));
  assert.equal(q.get("root"), "/tmp/a b");
  assert.equal(q.get("path"), "sub/x.png");
});

/*
  **两张表必须对得上。** 前端按扩展名决定「渲染成播放器」，后端按扩展名决定
  `content-type`。这边认、那边不认的话，播放器拿到的是 `application/octet-stream`——
  它不会报错，只是什么都不发生，正是最难查的那种失效。

  所以这条用例不写死清单，而是直接去读后端那张表：谁多谁少都当场看得见。
*/
const backendTypes = readFileSync(new URL("../../backend/src/fs.ts", import.meta.url).pathname, "utf8");
/** 后端表里所有映射到某一类 content-type 的扩展名。 */
function backendExtensions(prefix: string): string[] {
  const table = /const RAW_CONTENT_TYPES[^{]*\{([\s\S]*?)\n\};/.exec(backendTypes);
  assert.ok(table, "backend/src/fs.ts 里找不到 RAW_CONTENT_TYPES");
  const body = table[1].replace(/\/\*[\s\S]*?\*\//g, " ");
  return [...body.matchAll(/^\s*([a-z0-9]+):\s*"([^"]+)"/gm)]
    .filter(([, , type]) => type.startsWith(prefix))
    .map(([, ext]) => ext)
    .sort();
}

for (const [kind, plugin, prefix] of [
  ["audio", audioPlugin, "audio/"],
  ["video", videoPlugin, "video/"],
] as const) {
  test(`${kind} 插件认的扩展名和后端那张表一字不差`, () => {
    const expected = backendExtensions(prefix);
    assert.ok(expected.length > 0, `后端表里一个 ${prefix} 都没有？`);
    for (const ext of expected) {
      assert.equal(plugin.match(`a.${ext}`), true, `后端会把 .${ext} 发成 ${prefix}…，前端却不渲染播放器`);
      assert.equal(plugin.match(`a.${ext.toUpperCase()}`), true, `.${ext} 大写也该认`);
    }
    // 反向：前端认的每一个，后端也得认。拿另一类和图片/pdf 做反例。
    for (const ext of [...backendExtensions("image/"), ...backendExtensions("application/"), "txt", "md"]) {
      assert.equal(plugin.match(`a.${ext}`), false, `.${ext} 不该被当成 ${kind}`);
    }
    assert.equal(plugin.match(`${kind}.txt`), false, "只看扩展名，不看名字里有没有这个词");
  });
}

test("两个播放器插件都挂进了注册表——只写不挂等于没做", () => {
  for (const [name, plugin] of [["audio", audioPlugin], ["video", videoPlugin]] as const) {
    assert.ok(EDITOR_PLUGINS.includes(plugin), `${name} 插件没有出现在 EDITOR_PLUGINS 里`);
  }
  // 匹配顺序：先到先得，所以播放器不能排在会抢走它们的插件后面。
  const first = (f: string) => EDITOR_PLUGINS.find(p => p.match(f));
  assert.equal(first("a.mp4"), videoPlugin);
  assert.equal(first("a.mp3"), audioPlugin);
});
