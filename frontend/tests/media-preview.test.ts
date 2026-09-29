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

/*
  视频要跟着面板走。**这条挡的是「把百分比那套写回去」。**

  实测(640×360 的视频，两块面板)：

      写法                     900×487 面板      420×167 面板
      max-h-full max-w-full    640×360 不填满    381×214 溢出、上下被切
      h-full w-full            861×484 填满      381×214 仍然溢出
      外层 absolute inset-3     876×463 填满      396×143 正好

  前两种在矮面板里都不行：那个网格项的高度不确定，`height:100%` / `max-height:100%`
  解析不出来。所以播放器必须待在一个**尺寸确定**的绝对定位盒子里。

  扫源码而不是量渲染：要挡的正是「有人照着图片那条抄回去」，而那一改不会有任何用例变红。
*/
test("视频待在确定尺寸的盒子里，不靠百分比自适应", () => {
  const source = readFileSync(new URL("../src/plugins/media/index.tsx", import.meta.url).pathname, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")   // JSX 注释里会原样写着这些类名
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  // 别用 [^>]*：属性里的箭头函数 `() => …` 自带一个 `>`，会把匹配截断。
  const video = /<video[\s\S]*?\/>/.exec(source);
  assert.ok(video, "找不到 <video>");
  assert.match(video[0], /className="h-full w-full object-contain"/,
    "播放器要填满它的盒子并保持比例");
  assert.doesNotMatch(video[0], /max-h-full|max-w-full/,
    "max-h-full/max-w-full 在矮面板里解析不出来——实测 420×167 的面板里视频会涨到 381×214 被切掉");
  /*
    参照物也要钉住。插件根节点本身就是 `absolute inset-0`，所以这个盒子的父级一旦没了
    `relative`，`inset-3` 就改以根节点为准——视频会盖到上面那条标题栏上。
    （变异测试里正是这一条先漏了网。）
  */
  assert.match(source, /<div className="relative min-h-0 flex-1">\s*<div className="absolute inset-3">\s*<video/,
    "<video> 要待在 relative 容器内的绝对盒子里：少了 relative 会以插件根节点定位、盖住标题栏；" +
    "少了绝对盒子则上面那个 h-full 落空");
});
