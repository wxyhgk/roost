import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { contentTypeFor, statRawFile, streamedMedia } from "../src/fs.ts";
import { parseByteRange } from "../src/http.ts";
const { createWorkspaceStore } = await import("@roost/workspace-store");
const { createTerminalRuntime } = await import("@roost/terminal-runtime");
const { createBackendServer } = await import("../src/server.ts");

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "roost-raw-"));
  const store = createWorkspaceStore({ dataDir: dir });
  store.upsertSession({id:'file-workspace',cwd:dir});
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: "/bin/sh", env: {}, historyStore: store });
  const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, base };
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");

test("content types map image and pdf extensions, unknown falls back", () => {
  assert.equal(contentTypeFor("a.png"), "image/png");
  assert.equal(contentTypeFor("a.JPG"), "image/jpeg");
  assert.equal(contentTypeFor("a.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("a.pdf"), "application/pdf");
  assert.equal(contentTypeFor("a.bin"), "application/octet-stream");
  assert.equal(contentTypeFor("noext"), "application/octet-stream");
});

test("raw endpoint serves image and pdf bytes inline", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, "dot.png"), PNG);
  await writeFile(join(f.dir, "doc.pdf"), PDF);
  for (const [name, bytes, type] of [
    ["dot.png", PNG, "image/png"],
    ["doc.pdf", PDF, "application/pdf"],
  ] as const) {
    const res = await fetch(
      `${f.base}/api/file/raw?root=${encodeURIComponent(f.dir)}&path=${encodeURIComponent(name)}`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), type);
    assert.equal(res.headers.get("content-disposition"), `inline; filename*=UTF-8''${name}`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  }
});

test("raw endpoint rejects missing, directory, escape and oversize files", async (t) => {
  const f = await fixture(t);
  const q = (path: string) =>
    `${f.base}/api/file/raw?root=${encodeURIComponent(f.dir)}&path=${encodeURIComponent(path)}`;
  assert.equal((await fetch(q("missing.png"))).status, 404);
  assert.equal((await fetch(q(""))).status, 400);
  assert.equal((await fetch(q("."))).status, 400);
  assert.equal((await fetch(q("../outside.png"))).status, 403);
  await writeFile(join(f.dir, "big.png"), PNG);
  await truncate(join(f.dir, "big.png"), 64 * 1024 * 1024 + 1);
  assert.equal((await fetch(q("big.png"))).status, 413);
});

test("statRawFile reports size and type without reading content", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, "dot.png"), PNG);
  const raw = await statRawFile(f.dir, "dot.png");
  assert.equal(raw.name, "dot.png");
  assert.equal(raw.size, PNG.length);
  assert.equal(raw.contentType, "image/png");
  await assert.rejects(statRawFile(f.dir, "."), /not a file/);
});

test("download=1 switches to attachment and keeps non-ascii names intact", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, "分子 图.png"), PNG);
  const res = await fetch(
    `${f.base}/api/file/raw?root=${encodeURIComponent(f.dir)}&path=${encodeURIComponent("分子 图.png")}&download=1`,
  );
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("content-disposition"),
    `attachment; filename*=UTF-8''${encodeURIComponent("分子 图.png")}`,
  );
  // 内容类型不变：attachment 的时候浏览器不靠它渲染，但代理和下载管理器还看它。
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

/*
  64 MiB 那道闸是**预览**的闸——inline 的东西整份留在标签页内存里。下载是流式的，
  拿预览的理由去拦它等于凭空给「把文件取回本机」加一个天花板。

  只验头就把连接掐了：这里的 big.png 是个 64 MiB 的稀疏文件，真收完纯属浪费。
*/
test("download=1 is not subject to the inline size cap", async (t) => {
  const f = await fixture(t);
  const q = (path: string) =>
    `${f.base}/api/file/raw?root=${encodeURIComponent(f.dir)}&path=${encodeURIComponent(path)}`;
  await writeFile(join(f.dir, "big.png"), PNG);
  await truncate(join(f.dir, "big.png"), 64 * 1024 * 1024 + 1);
  assert.equal((await fetch(q("big.png"))).status, 413);
  const res = await fetch(`${q("big.png")}&download=1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(res.headers.get("content-length"), String(64 * 1024 * 1024 + 1));
  await res.body?.cancel();
});

/*
  Range 是播放器的刚需，不是优化。`<video>` 先要头部拿时长，拖进度条时按字节区间要中间
  那一段；iPad 上的 Safari 拿不到 206 甚至不开始播，界面上是个点不动的播放器、不报错。
  所以这一组用例盯的是「区间算得对不对」和「该说的头有没有说」。
*/
test("byte ranges: 区间、后缀、开区间、夹断、不可满足、多段回落", () => {
  assert.deepEqual(parseByteRange("bytes=0-3", 10), { start: 0, end: 3 });
  assert.deepEqual(parseByteRange("bytes=5-", 10), { start: 5, end: 9 }, "缺末端=到文件尾");
  assert.deepEqual(parseByteRange("bytes=-3", 10), { start: 7, end: 9 }, "后缀区间=最后 N 个字节");
  assert.deepEqual(parseByteRange("bytes=-99", 10), { start: 0, end: 9 }, "后缀比文件长就给整份，这是规范要求的");
  assert.deepEqual(parseByteRange("bytes=8-99", 10), { start: 8, end: 9 }, "末端超出要夹到最后一个字节，不算错");
  // 规范里 `bytes=` 后面不允许空白，真实播放器也不会发。**不认识就当没有 Range**——
  // 回整份是安全的回落，比报错好：错的头不该让一个本来能播的文件播不了。
  assert.equal(parseByteRange("bytes= 0-1", 10), null, "格式不对要回落到整份，不是报错");
  assert.equal(parseByteRange("bytes=10-", 10), "unsatisfiable", "起点等于长度就已经越界了");
  assert.equal(parseByteRange("bytes=3-1", 10), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", 10), "unsatisfiable", "要最后 0 个字节，无从满足");
  assert.equal(parseByteRange("bytes=0-0", 0), "unsatisfiable", "空文件没有第 0 个字节");
  assert.equal(parseByteRange(undefined, 10), null, "没有 Range 就是要整份");
  assert.equal(parseByteRange("bytes=0-1,4-5", 10), null, "多段不理解，按规范回落到整份而不是报错");
  assert.equal(parseByteRange("items=0-1", 10), null, "别的单位一律不认");
  assert.equal(parseByteRange("bytes=-", 10), null);
});

test("content types cover audio and video, otherwise播放器什么都不会做", () => {
  for (const [name, type] of [
    ["a.mp3", "audio/mpeg"], ["a.M4A", "audio/mp4"], ["a.wav", "audio/wav"],
    ["a.ogg", "audio/ogg"], ["a.opus", "audio/ogg"], ["a.flac", "audio/flac"],
    ["a.mp4", "video/mp4"], ["a.webm", "video/webm"], ["a.mov", "video/quicktime"],
  ] as const) assert.equal(contentTypeFor(name), type, name);
  assert.equal(streamedMedia("video/mp4"), true);
  assert.equal(streamedMedia("audio/mpeg"), true);
  assert.equal(streamedMedia("image/png"), false, "图片整份进内存，仍然该受预览上限约束");
  assert.equal(streamedMedia("application/pdf"), false);
});

test("raw endpoint answers ranges with 206 and advertises accept-ranges everywhere", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("0123456789");
  await writeFile(join(f.dir, "clip.mp3"), bytes);
  const url = `${f.base}/api/file/raw?root=${encodeURIComponent(f.dir)}&path=${encodeURIComponent("clip.mp3")}`;

  const whole = await fetch(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes", "整份响应上也要有，播放器靠它决定敢不敢发区间");
  assert.equal(whole.headers.get("content-type"), "audio/mpeg");

  const part = await fetch(url, { headers: { range: "bytes=2-5" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(part.headers.get("content-length"), "4");
  assert.equal(await part.text(), "2345", "区间要真的只发那几个字节");

  const suffix = await fetch(url, { headers: { range: "bytes=-3" } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), "789");

  const past = await fetch(url, { headers: { range: "bytes=99-" } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), "bytes */10", "416 要告诉对方文件到底多长");
  assert.equal(await past.text(), "");
});

/*
  视频动辄几百 MB，而 64 MiB 那道闸是给**预览**设的（inline 的东西整份留在标签页内存里）。
  `<video>` 边下边播、内存是常数，和 download=1 同理——拿预览的理由去拦播放，结果就是
  「超过 64 MiB 的视频一律打不开」，而那正是视频的常态。
*/
test("media is not subject to the inline preview cap, images still are", async (t) => {
  const f = await fixture(t);
  const q = (path: string) =>
    `${f.base}/api/file/raw?root=${encodeURIComponent(f.dir)}&path=${encodeURIComponent(path)}`;
  for (const name of ["big.mp4", "big.png"]) {
    await writeFile(join(f.dir, name), "x");
    await truncate(join(f.dir, name), 64 * 1024 * 1024 + 1);
  }
  assert.equal((await fetch(q("big.png"))).status, 413, "图片仍然受上限约束");
  // 只要头，别真收 64 MiB：发个小区间即可，它同样要先过那道闸。
  const video = await fetch(q("big.mp4"), { headers: { range: "bytes=0-3" } });
  assert.equal(video.status, 206);
  assert.equal(video.headers.get("content-range"), "bytes 0-3/67108865");
  await video.body?.cancel();
});
