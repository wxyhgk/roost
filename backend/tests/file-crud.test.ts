import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createPath, deletePath, FileWriteError, renamePath } from "../src/fs.ts";
const { createWorkspaceStore } = await import("@roost/workspace-store");
const { createTerminalRuntime } = await import("@roost/terminal-runtime");
const { createBackendServer } = await import("../src/server.ts");

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "roost-crud-"));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: "/bin/sh", env: {}, historyStore: store });
  const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const root = mkdtempSync(join(tmpdir(), "roost-crud-ws-"));
  store.upsertSession({id:'file-workspace',cwd:root});
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { dir, root, base: `http://127.0.0.1:${port}` };
}

test("GET /api/file and /api/fs report precise statuses", async (t) => {
  const f = await fixture(t);
  const get = (path: string) => fetch(`${f.base}${path}`).then(status);
  const q = (p: string) => `/api/file?root=${encodeURIComponent(f.root)}&path=${encodeURIComponent(p)}`;
  await writeFile(join(f.root, "a.txt"), "a");
  assert.equal((await get(q("a.txt"))).status, 200);
  assert.equal((await get(q("missing.txt"))).status, 404);
  assert.equal((await get(q("../outside.txt"))).status, 403);
  const dir = (p: string) => `/api/fs?root=${encodeURIComponent(f.root)}&path=${encodeURIComponent(p)}`;
  assert.equal((await get(dir(""))).status, 200);
  assert.equal((await get(dir("missing"))).status, 404);
  assert.equal((await get(dir("../outside"))).status, 403);
});

async function status(res: Response) {
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, body };
}

test("createPath makes files and directories without overwriting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roost-crud-unit-"));
  try {
    assert.deepEqual(await createPath(dir, "a.txt", "file"), { name: "a.txt", path: "a.txt" });
    assert.deepEqual(await createPath(dir, "sub", "dir"), { name: "sub", path: "sub" });
    assert.deepEqual(await createPath(dir, "sub/nested.txt", "file"), { name: "nested.txt", path: "sub/nested.txt" });
    await assert.rejects(createPath(dir, "a.txt", "file"), (e: unknown) => e instanceof FileWriteError && e.status === 409);
    await assert.rejects(createPath(dir, "a.txt", "dir"), (e: unknown) => e instanceof FileWriteError && e.status === 409);
    await assert.rejects(createPath(dir, "missing/kid.txt", "file"), (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createPath rejects escapes through lexical and symlink parents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roost-crud-esc-"));
  try {
    await assert.rejects(createPath(dir, "../evil.txt", "file"), /path escapes workspace/);
    await mkdir(join(dir, "inside"));
    const outside = mkdtempSync(join(tmpdir(), "roost-crud-outside-"));
    try {
      await symlink(outside, join(dir, "inside", "out"));
      await assert.rejects(createPath(dir, "inside/out/evil.txt", "file"), /path escapes workspace/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renamePath moves without overwriting and guards the root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roost-crud-mv-"));
  try {
    await writeFile(join(dir, "old.txt"), "x");
    await writeFile(join(dir, "taken.txt"), "y");
    assert.deepEqual(await renamePath(dir, "old.txt", "new.txt"), { name: "new.txt", path: "new.txt" });
    await assert.rejects(stat(join(dir, "old.txt")), /ENOENT/);
    await assert.rejects(renamePath(dir, "new.txt", "taken.txt"), (e: unknown) => e instanceof FileWriteError && e.status === 409);
    await assert.rejects(renamePath(dir, "missing.txt", "gone.txt"), (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT");
    await assert.rejects(renamePath(dir, "", "root"), /workspace root/);
    await assert.rejects(renamePath(dir, "new.txt", "../outside.txt"), /path escapes workspace/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deletePath removes files and trees but never the root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roost-crud-rm-"));
  try {
    await writeFile(join(dir, "f.txt"), "x");
    await mkdir(join(dir, "tree", "deep"), { recursive: true });
    await writeFile(join(dir, "tree", "deep", "leaf.txt"), "y");
    assert.deepEqual(await deletePath(dir, "f.txt"), { ok: true });
    assert.deepEqual(await deletePath(dir, "tree"), { ok: true });
    await assert.rejects(stat(join(dir, "tree")), /ENOENT/);
    await assert.rejects(deletePath(dir, ""), /workspace root/);
    await assert.rejects(deletePath(dir, "../outside"), /path escapes workspace/);
    await assert.rejects(deletePath(dir, "gone.txt"), (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/fs validates kind and reports conflicts", async (t) => {
  const f = await fixture(t);
  const post = (body: unknown) => fetch(`${f.base}/api/fs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(status);
  assert.equal((await post({ root: f.root, path: "n.txt", kind: "file" })).status, 201);
  assert.equal((await post({ root: f.root, path: "n.txt", kind: "file" })).status, 409);
  assert.equal((await post({ root: f.root, path: "d", kind: "dir" })).status, 201);
  assert.equal((await post({ root: f.root, path: "x", kind: "folder" })).status, 400);
  assert.equal((await post({ root: f.root, path: "../evil", kind: "file" })).status, 403);
  assert.equal((await post({ root: "", path: "x", kind: "file" })).status, 400);
});

test("PATCH and DELETE /api/fs move and remove", async (t) => {
  const f = await fixture(t);
  const send = (method: string, body: unknown) => fetch(`${f.base}/api/fs`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(status);
  await writeFile(join(f.root, "a.txt"), "a");
  const renamed = await send("PATCH", { root: f.root, path: "a.txt", newPath: "b.txt" });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body, { name: "b.txt", path: "b.txt" });
  assert.equal((await send("PATCH", { root: f.root, path: "b.txt" })).status, 400);
  assert.equal((await send("PATCH", { root: f.root, path: "nope.txt", newPath: "x.txt" })).status, 404);
  assert.equal((await send("DELETE", { root: f.root, path: "b.txt" })).status, 200);
  assert.equal((await send("DELETE", { root: f.root, path: "b.txt" })).status, 404);
  await assert.rejects(stat(join(f.root, "b.txt")), /ENOENT/);
});
