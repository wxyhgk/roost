import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { contentTypeFor, statRawFile } from "../src/fs.ts";
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
