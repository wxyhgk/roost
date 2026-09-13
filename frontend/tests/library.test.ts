import { test } from "node:test";
import assert from "node:assert/strict";
import { LibraryClient } from "../src/features/library/client.ts";
import { LibraryError, type RecordData, type Transport } from "../src/features/library/api.ts";
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(k: string) { return this.data.get(k) ?? null; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  removeItem(k: string) { this.data.delete(k); }
  setItem(k: string, v: string) { this.data.set(k, v); }
}
const record = (text = "original", revision = 1): RecordData => ({ id: "old-note", text, revision, createdAt: 1, updatedAt: revision, deletedAt: null });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const transport = (fn: (path: string, method?: string, body?: any) => Promise<unknown>): Transport => fn as Transport;

test("same-record saves serialize with latest revision; late response never erases typing", async () => {
  const first = deferred<RecordData>(); const calls: any[] = [];
  const c = new LibraryClient(transport(async (path, method, body) => {
    if (path === "library/info") return { libraryId: "test" };
    if (!method) return record();
    calls.push(body);
    if (calls.length === 1) return first.promise;
    return record(body.text, 3);
  }), new MemoryStorage());
  const d = await c.open("notes", "old-note");
  c.edit(d, { text: "first" }); const saving = c.flush(d);
  c.edit(d, { text: "second" }); void c.flush(d);
  await Promise.resolve(); assert.equal(calls.length, 1); first.resolve(record("first", 2)); await saving;
  assert.deepEqual(calls, [{ revision: 1, text: "first" }, { revision: 2, text: "second" }]);
  assert.equal(d.value.text, "second"); assert.equal(d.state, "saved");
  assert.equal([...((c.storage as MemoryStorage).data.keys())].filter(k => k.startsWith("roost-library-draft:")).length, 0); c.dispose();
});

test("500ms debounce and 2s maximum continuous typing interval", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const c = new LibraryClient(transport(async (path, method, body) => {
    if (path === "library/info") return { libraryId: "test" };
    if (!method) return record(); calls++; return record(body.text, calls + 1);
  }), new MemoryStorage());
  const d = await c.open("notes", "old-note");
  c.edit(d, { text: "a" }); t.mock.timers.tick(499); assert.equal(calls, 0);
  t.mock.timers.tick(1); await d.pending; assert.equal(calls, 1);
  for (let i = 0; i < 5; i++) { c.edit(d, { text: `continuous ${i}` }); t.mock.timers.tick(400); }
  await d.pending; assert.equal(calls, 2); assert.equal(d.value.text, "continuous 4"); c.dispose();
});

test("409 retains local draft and current, explicit adopt replaces it; 410 allows copy", async () => {
  let deleted = false;
  const c = new LibraryClient(transport(async (path, method, body) => {
    if (path === "library/info") return { libraryId: "test" };
    if (!method) return record();
    if (method === "POST") return { ...record(body.text), id: body.id };
    throw new LibraryError(deleted ? 410 : 409, "conflict", deleted ? { ...record(), deletedAt: 10 } : record("remote", 2));
  }), new MemoryStorage());
  const d = await c.open("notes", "old-note"); c.edit(d, { text: "local" }); await c.flush(d);
  assert.equal(d.state, "conflict"); assert.equal(d.value.text, "local"); assert.equal(d.current?.text, "remote");
  c.adopt(d); assert.equal(d.value.text, "remote"); assert.equal(d.state, "saved");
  deleted = true; c.edit(d, { text: "keep after deletion" }); await c.flush(d);
  assert.equal(d.deleted, true); const copy = await c.copy(d);
  assert.notEqual(copy.value.id, d.value.id); assert.equal(copy.value.text, "keep after deletion"); assert.equal(copy.state, "saved"); c.dispose();
});

test("503 and offline preserve backups; reload restore compares revision before writing", async () => {
  const storage = new MemoryStorage(); let fail = true; let patches = 0;
  const api = transport(async (path, method, body) => {
    if (path === "library/info") return { libraryId: "test" };
    if (!method) return record(fail ? "original" : "other window", fail ? 1 : 2);
    patches++; if (fail) throw new LibraryError(503, "busy"); return record(body.text, 3);
  });
  const c = new LibraryClient(api, storage); const d = await c.open("notes", "old-note");
  c.edit(d, { text: "recover this" }); await c.flush(d); assert.equal(d.state, "failed"); c.dispose();
  fail = false; const restored = new LibraryClient(api, storage); await restored.init();
  assert.equal(restored.backups().length, 1);
  const r = await restored.restore(restored.backups()[0]);
  assert.equal(r.state, "conflict"); assert.equal(r.value.text, "recover this"); assert.equal(patches, 1); restored.dispose();
});

test("PATCH response loss recognizes exact target and continues newer edits", async () => {
  let remote = record(); let lost = true;
  const c = new LibraryClient(transport(async (path, method, body) => {
    if (path === "library/info") return { libraryId: "test" };
    if (!method) return remote;
    if (lost) { lost = false; remote = record(body.text, 2); throw new LibraryError(0, "offline"); }
    if (body.revision !== remote.revision) throw new LibraryError(409, "stale", remote);
    remote = record(body.text, remote.revision + 1); return remote;
  }), new MemoryStorage());
  const d = await c.open("notes", "old-note"); c.edit(d, { text: "committed" }); await c.flush(d);
  assert.equal(d.state, "failed"); await c.retry(d); assert.equal(d.state, "saved"); assert.equal(d.base.revision, 2); c.dispose();
});

test("POST retry keeps original ID/body when draft changed after response loss", async () => {
  const bodies: any[] = []; let fail = true;
  const c = new LibraryClient(transport(async (path, method, body) => {
    if (path === "library/info") return { libraryId: "test" };
    bodies.push({ method, ...body });
    if (fail) { fail = false; throw new LibraryError(0, "offline"); }
    return { ...record(body.text, method === "POST" ? 1 : 2), id: body.id ?? bodies[0].id };
  }), new MemoryStorage());
  const d = await c.create("notes", { text: "original POST" });
  c.edit(d, { text: "edited after failure" }); await c.retry(d);
  assert.deepEqual(bodies[0], bodies[1]); assert.equal(bodies[2].revision, 1); assert.equal(bodies[2].text, "edited after failure"); assert.equal(d.state, "saved"); c.dispose();
});

test("late refresh cannot overwrite newer save; clean refresh updates code/title/lang", async () => {
  const refresh = deferred<RecordData>(); let gets = 0;
  const c = new LibraryClient(transport(async (path, method, body) => {
    if (path === "library/info") return { libraryId: "test" };
    if (!method) { gets++; return gets === 1 ? record() : refresh.promise; }
    return record(body.text, 3);
  }), new MemoryStorage());
  const d = await c.open("notes", "old-note"); const refreshing = c.refresh(d);
  c.edit(d, { text: "newer" }); await c.flush(d); refresh.resolve(record("old response", 2)); await refreshing;
  assert.equal(d.value.text, "newer"); assert.equal(d.base.revision, 3); c.dispose();
});

test("search and pagination pass opaque cursor without fetching detail", async () => {
  const paths: string[] = [];
  const c = new LibraryClient(transport(async path => { paths.push(path); return path === "library/info" ? { libraryId: "test" } : { items: [], nextCursor: null }; }), new MemoryStorage());
  await c.list("snippets", "中文 %_", "cursor+/=");
  const url = new URL(paths[1], "http://test/"); assert.equal(url.searchParams.get("q"), "中文 %_"); assert.equal(url.searchParams.get("cursor"), "cursor+/="); assert.equal(paths.length, 2);
});

test("cached library identity exposes drafts offline without authorizing writes to an unverified backend", async () => {
  const storage = new MemoryStorage(); storage.setItem("roost-library-last-id", "cached");
  let posts = 0;
  const c = new LibraryClient(transport(async (_path, method) => { if (method) posts++; throw new LibraryError(0, "offline"); }), storage);
  const d = await c.create("notes", { text: "offline new draft" });
  assert.equal(d.state, "failed"); assert.equal(posts, 0); c.dispose();
  const reload = new LibraryClient(c.api, storage);
  assert.equal(reload.libraryId, "cached"); assert.equal(reload.backups()[0].value.text, "offline new draft"); reload.dispose();
});

test("clean detail refresh replaces snippet content; dirty refresh keeps local draft", async () => {
  let remote: RecordData = { ...record(), text: undefined, code: "one", title: "title", lang: "python" };
  const c = new LibraryClient(transport(async path => path === "library/info" ? { libraryId: "test" } : remote), new MemoryStorage());
  const d = await c.open("snippets", "old-note");
  remote = { ...remote, code: "two", title: "remote title", lang: "typescript", revision: 2 };
  await c.refresh(d); assert.equal(d.value.code, "two"); assert.equal(d.value.lang, "typescript");
  c.edit(d, { code: "local" }); remote = { ...remote, code: "three", revision: 3 };
  await c.refresh(d); assert.equal(d.value.code, "local"); assert.equal(d.current?.code, "three"); assert.equal(d.state, "conflict"); c.dispose();
});

test("first-ever offline selection save persists a new draft before any library identity is available", async () => {
  const storage = new MemoryStorage();
  const offline = transport(async () => { throw new LibraryError(0, "offline"); });
  const c = new LibraryClient(offline, storage);
  const d = await c.create("snippets", { title: "selection", code: "keep selected text", lang: "plaintext" });
  assert.equal(d.state, "failed"); c.dispose();
  const online = new LibraryClient(transport(async (path, _method, body) => path === "library/info" ? { libraryId: "new-library" } : { ...record(), id: body.id, ...body }), storage);
  await online.init(); assert.equal(online.backups().length, 1);
  const r = await online.restore(online.backups()[0]); assert.equal(r.state, "saved"); assert.equal(r.value.code, "keep selected text"); online.dispose();
});

test("discarding legacy collections removes migration artifacts while preserving API drafts and preferences", async () => {
  const { discardLegacyLibrary } = await import("../src/features/library/legacy-cleanup.ts");
  const storage = new MemoryStorage();
  for (const key of ["diy-notes-v1", "diy-library-legacy-backup-v1", "diy-library-source-v1", "diy-library-import:one", "diy-library-import:two", "diy-library-draft:current:one", "diy-library-last-id", "diy-theme"]) storage.setItem(key, "keep");
  discardLegacyLibrary(storage);
  assert.deepEqual([...storage.data.keys()], ["diy-library-draft:current:one", "diy-library-last-id", "diy-theme"]);
  discardLegacyLibrary(storage); assert.equal(storage.length, 3);
});

// 改名那一刻浏览器里存着的还是旧键。真算数据的只有草稿——丢了就是丢掉没存盘的写作。
test("adopting roost keys renames the survivors and never clobbers a newer value", async () => {
  const { adoptRoostKeys } = await import("../src/features/library/legacy-cleanup.ts");
  const storage = new MemoryStorage();
  storage.setItem("diy-library-draft:current:one", "unsaved");
  storage.setItem("diy-library-last-id", "lib");
  storage.setItem("diy-theme", "light");
  adoptRoostKeys(storage);
  assert.deepEqual([...storage.data.keys()].sort(), ["roost-library-draft:current:one", "roost-library-last-id", "roost-theme"]);
  assert.equal(storage.getItem("roost-library-draft:current:one"), "unsaved");
  // 搬过一次之后再跑一遍不该动任何东西。
  adoptRoostKeys(storage); assert.equal(storage.length, 3);
  // 新键已经有值：那是搬完之后写的，比旧的新，不能被旧值盖掉。
  storage.setItem("diy-theme", "dark");
  adoptRoostKeys(storage);
  assert.equal(storage.getItem("roost-theme"), "light");
  assert.equal(storage.getItem("diy-theme"), null);
});

const realFetch = globalThis.fetch;
async function withFetch<T>(stub: typeof globalThis.fetch, run: () => Promise<T>) {
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = realFetch; }
}
const reply = (status: number, body: string) =>
  (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;

test("library errors read from the shared code table, not the backend's English prose", async () => {
  const { request } = await import("../src/features/library/api.ts");

  // 后端这条消息是英文的；code 已经完全确定了含义，应当用共享表里的中文。
  await withFetch(reply(503, JSON.stringify({ error: { code: "storage_unavailable", message: "library storage temporarily unavailable; retry later" } })),
    async () => {
      await assert.rejects(request("notes"), (e: Error) => {
        assert.equal(e.message, "存储暂时不可用，请稍后重试");
        return true;
      });
    });

  // invalid_request 的 message 是载荷——哪个字段不合法只有后端知道。
  await withFetch(reply(400, JSON.stringify({ error: { code: "invalid_request", message: "title must be at most 200 characters" } })),
    async () => {
      await assert.rejects(request("notes"), (e: Error) => {
        assert.equal(e.message, "title must be at most 200 characters");
        return true;
      });
    });

  // 代理返回的 HTML 错误页曾经会被整页当成消息显示。
  await withFetch(reply(502, "<html><body>502 Bad Gateway</body></html>"),
    async () => {
      await assert.rejects(request("notes"), (e: Error) => {
        assert.equal(e.message, "请求失败（502）");
        return true;
      });
    });
});
