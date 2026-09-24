import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createWorkspaceStore } from "../src/index.ts";

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "roost-workspace-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("importing the package opens no database and ignores environment defaults", (t) => {
  const dir = directory(t);
  /*
    `--import tsx` 不能省：包的入口是 `.ts`，而原生剥类型是 Node 23.6 才默认开的。
    在我们声明支持的下限（22.13）上，这个子进程会死在 `ERR_UNKNOWN_FILE_EXTENSION` 上，
    而这条测试想问的是「导入它会不会开数据库」，不是「node 认不认识 .ts」。

    **要传解析好的绝对位置**，不能直接写 `tsx`：子进程的 cwd 是临时目录（测的就是
    「那里不该出现任何文件」），从那儿解析不到仓库的 node_modules。
  */
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
    `await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});`,
  ], {
    cwd: dir,
    env: { ...process.env, HOME: dir, ROOST_DATA_DIR: join(dir, "ignored") },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(dir), []);
});

test("legacy SQLite schema migrates without losing raw, snapshot, or timestamp", (t) => {
  const dir = directory(t);
  const legacy = new DatabaseSync(join(dir, "workspace.sqlite"));
  legacy.exec(`CREATE TABLE terminal_replay (
    session_id TEXT PRIMARY KEY, raw TEXT NOT NULL DEFAULT '',
    snapshot TEXT, updated_at INTEGER NOT NULL
  )`);
  legacy.prepare("INSERT INTO terminal_replay VALUES (?, ?, ?, ?)").run("old", "AB", "A", 1);
  legacy.close();
  const store = createWorkspaceStore({ dataDir: dir });
  try {
    assert.deepEqual(store.getTerminalReplay("old"), {
      raw: "AB", snapshot: "A", updatedAt: 1, stateJson: null,
    });
    // The store treats replay metadata as an opaque string, including invalid JSON.
    store.setTerminalReplay("old", "new raw", null, "opaque metadata");
    const row = store.getTerminalReplay("old")!;
    assert.equal(row.raw, "new raw");
    assert.equal(row.snapshot, null);
    assert.equal(row.stateJson, "opaque metadata");
    assert.ok(row.updatedAt > 1);
  } finally { store.close(); }
  const reopened = createWorkspaceStore({ dataDir: dir });
  try { assert.equal(reopened.getTerminalReplay("old")?.stateJson, "opaque metadata"); }
  finally { reopened.close(); }
});

test("workspace CRUD preserves project grouping, ordering, selection, and closed state", (t) => {
  const store = createWorkspaceStore({ dataDir: directory(t) });
  t.after(() => store.close());
  assert.deepEqual(store.loadWorkspace(), {
    sessions: [], projects: [], selectedId: null, selectedConversationId: null, followTerminalConversation: false, expandedProjectIds: [], pinnedSessionIds: [], pinnedAppPorts: [], sessionSeq: 0, projectSeq: 0,
  });
  const project = store.createProject({ id: "p", name: "Project", color: "#fff" });
  const other = store.createProject();
  // 默认名不带编号：计数器只增不减，编号会反映历史而不是当前有几个分组。
  assert.equal(other.name, "Project");
  assert.notEqual(other.id, project.id);
  assert.notEqual(other.color, project.color, "配色仍随 seq 轮换，便于区分同名分组");
  assert.deepEqual({ ...store.getProjectRecord(project.id) }, project);
  store.setProjectName(project.id, "Renamed");
  assert.equal(store.getProjectRecord(project.id)?.name, "Renamed");
  const first = store.upsertSession({ id: "s1", cwd: "/tmp/one", projectId: project.id });
  const second = store.upsertSession({ id: "s2", cwd: "/tmp/two" });
  assert.equal(first.title, "Terminal"); assert.equal(second.title, "Terminal");
  store.setSessionProject(second.id, project.id);
  store.setSessionTitle(first.id, "Named");
  store.setSessionCwd(first.id, "/tmp/changed");
  store.setSessionClosed(first.id, true);
  store.setSelectedId(second.id);
  store.setExpandedProjectIds([project.id]);
  const workspace = store.loadWorkspace();
  assert.deepEqual(workspace.sessions, [
    { id: "s1", title: "Named", note: null, cwd: "/tmp/changed", projectId: "p", closed: true },
    { id: "s2", title: "Terminal", note: null, cwd: "/tmp/two", projectId: "p", closed: false },
  ]);
  assert.equal(workspace.selectedId, "s2");
  assert.deepEqual(workspace.expandedProjectIds, ["p"]);
  assert.equal(workspace.sessionSeq, 2);
  assert.deepEqual(store.listSessionIds().sort(), ["s1", "s2"]);
  store.upsertSession({ id: first.id, cwd: "/tmp/reopened", closed: false });
  assert.deepEqual(store.getSessionRecord(first.id), {
    id: "s1", title: "Named", note: null, cwd: "/tmp/reopened", projectId: "p", closed: false,
  });
  assert.equal(store.loadWorkspace().sessionSeq, 2);
  store.setSessionProject(second.id, null);
  assert.equal(store.getSessionRecord(second.id)?.projectId, null);
  store.setTerminalReplay(first.id, "history", "snapshot", "metadata");
  store.deleteSessionRecord(first.id);
  assert.equal(store.getSessionRecord(first.id), null);
  assert.equal(store.getTerminalReplay(first.id), null);
  store.setSelectedId(null); store.setExpandedProjectIds([]);
  assert.equal(store.loadWorkspace().selectedId, null);
  assert.deepEqual(store.loadWorkspace().expandedProjectIds, []);
  assert.deepEqual(store.listSessionIds(), ["s2"]);
});

test("two store instances keep sessions and replay isolated", (t) => {
  const one = createWorkspaceStore({ dataDir: join(directory(t), "nested", "one") });
  const two = createWorkspaceStore({ dataDir: directory(t) });
  t.after(() => { one.close(); two.close(); });
  one.upsertSession({ id: "same", cwd: "/one" });
  two.upsertSession({ id: "same", cwd: "/two" });
  one.setTerminalReplay("same", "one", null, "state-one");
  two.setTerminalReplay("same", "two", "snapshot-two");
  assert.equal(one.getSessionRecord("same")?.cwd, "/one");
  assert.equal(two.getSessionRecord("same")?.cwd, "/two");
  one.deleteTerminalReplay("same");
  assert.equal(one.getTerminalReplay("same"), null);
  assert.equal(two.getTerminalReplay("same")?.raw, "two");
  assert.equal(two.getTerminalReplay("same")?.stateJson, null);
  one.deleteSessionRecord("same");
  assert.equal(two.loadWorkspace().sessions.length, 1);
});

test("close releases the database and a new instance reopens persisted workspace", (t) => {
  const dir = directory(t);
  const store = createWorkspaceStore({ dataDir: dir });
  store.createProject({ id: "project", name: "Saved" });
  store.upsertSession({ id: "session", cwd: "/tmp", projectId: "project", closed: true });
  store.setSelectedId("session"); store.setExpandedProjectIds(["project"]);
  store.setTerminalReplay("session", "raw", "snapshot", "state");
  const expected = store.loadWorkspace();
  store.close();
  assert.throws(() => store.loadWorkspace());
  const reopened = createWorkspaceStore({ dataDir: dir });
  try {
    assert.deepEqual(reopened.loadWorkspace(), expected);
    assert.equal(reopened.getTerminalReplay("session")?.stateJson, "state");
  } finally { reopened.close(); }
});

test("deleting a project ungroups all sessions and persists their history and selection", (t) => {
  const dir = directory(t);
  const store = createWorkspaceStore({ dataDir: dir });
  store.createProject({ id: "remove" }); store.createProject({ id: "keep" });
  store.upsertSession({ id: "open", cwd: dir, projectId: "remove" });
  store.upsertSession({ id: "hidden", cwd: dir, projectId: "remove", closed: true });
  store.upsertSession({ id: "other", cwd: dir, projectId: "keep" });
  store.setTerminalReplay("open", "raw", "snapshot", "state");
  store.setTerminalReplay("hidden", "hidden history", null);
  store.setSelectedId("open"); store.setExpandedProjectIds(["remove", "keep", "remove"]);
  const before = store.loadWorkspace();
  const history = [store.getTerminalReplay("open"), store.getTerminalReplay("hidden")];
  try {
    assert.equal(store.deleteProjectRecord("remove"), true);
    const after = store.loadWorkspace();
    assert.deepEqual(after, {
      ...before, projects: before.projects.filter(p => p.id !== "remove"), expandedProjectIds: ["keep"],
      sessions: before.sessions.map(s => s.projectId === "remove" ? { ...s, projectId: null } : s),
    });
    assert.deepEqual([store.getTerminalReplay("open"), store.getTerminalReplay("hidden")], history);
  } finally { store.close(); }
  const reopened = createWorkspaceStore({ dataDir: dir });
  try {
    assert.equal(reopened.getProjectRecord("remove"), null);
    assert.equal(reopened.getSessionRecord("hidden")?.projectId, null);
    assert.equal(reopened.getSessionRecord("hidden")?.closed, true);
    assert.equal(reopened.loadWorkspace().selectedId, "open");
    assert.deepEqual([reopened.getTerminalReplay("open"), reopened.getTerminalReplay("hidden")], history);
  } finally { reopened.close(); }
});

test("empty project deletion works and missing or repeated deletion changes nothing", (t) => {
  const store = createWorkspaceStore({ dataDir: directory(t) }); t.after(() => store.close());
  store.createProject({ id: "empty" });
  assert.equal(store.deleteProjectRecord("empty"), true);
  const before = store.loadWorkspace();
  assert.equal(store.deleteProjectRecord("empty"), false);
  assert.equal(store.deleteProjectRecord("missing"), false);
  assert.deepEqual(store.loadWorkspace(), before);
});

test("project deletion rolls back grouping and expansion when SQLite rejects the delete", (t) => {
  const dir = directory(t); const store = createWorkspaceStore({ dataDir: dir });
  t.after(() => store.close());
  store.createProject({ id: "protected" });
  store.upsertSession({ id: "session", cwd: dir, projectId: "protected" });
  store.setExpandedProjectIds(["protected"]);
  const fixture = new DatabaseSync(join(dir, "workspace.sqlite"));
  fixture.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'test delete failure'); END");
  fixture.close();
  const before = store.loadWorkspace();
  assert.throws(() => store.deleteProjectRecord("protected"), /test delete failure/);
  assert.deepEqual(store.loadWorkspace(), before);
  // The failed transaction does not leave the connection locked in a transaction.
  store.createProject({ id: "still-usable" });
  assert.ok(store.getProjectRecord("still-usable"));
});

test("stale project references fail atomically without modifying records or sequence numbers", async t => {
  const { ProjectNotFoundError } = await import('../src/index.ts');
  const store = createWorkspaceStore({ dataDir: directory(t) }); t.after(() => store.close());
  store.createProject({ id: 'p' });
  store.upsertSession({ id: 's', cwd: '/original', title: 'original', projectId: 'p' });
  store.deleteProjectRecord('p');
  const before = store.loadWorkspace();
  assert.throws(() => store.upsertSession({ id: 'new', cwd: '/tmp', projectId: 'p' }), ProjectNotFoundError);
  assert.throws(() => store.upsertSession({ id: 's', cwd: '/wrong', title: 'wrong', projectId: 'p' }), ProjectNotFoundError);
  assert.throws(() => store.setSessionProject('s', 'p'), ProjectNotFoundError);
  assert.deepEqual(store.loadWorkspace(), before);
  store.createProject({ id: 'valid' }); store.setSessionProject('s', 'valid');
  assert.equal(store.getSessionRecord('s')?.projectId, 'valid');
  store.setSessionProject('s', null); assert.equal(store.getSessionRecord('s')?.projectId, null);
});

test("opening an old database ungroups orphaned sessions while preserving history and ordering", t => {
  const dir = directory(t); const initial = createWorkspaceStore({ dataDir: dir });
  initial.createProject({ id: 'exists' });
  initial.upsertSession({ id: 'orphan', cwd: '/tmp', closed: true });
  initial.upsertSession({ id: 'valid', cwd: '/tmp', projectId: 'exists' });
  initial.setSelectedId('valid'); initial.setTerminalReplay('orphan', 'saved', 'snapshot', 'opaque');
  const before = initial.loadWorkspace(); const replay = initial.getTerminalReplay('orphan'); initial.close();
  const fixture = new DatabaseSync(join(dir, 'workspace.sqlite'));
  fixture.exec("UPDATE sessions SET project_id = 'deleted' WHERE id = 'orphan'"); fixture.close();
  const store = createWorkspaceStore({ dataDir: dir });
  try { assert.deepEqual(store.loadWorkspace(), before); assert.deepEqual(store.getTerminalReplay('orphan'), replay); }
  finally { store.close(); }
});

test("projects reorder by sequence, keep their colours, and survive reopening", (t) => {
  const dir = directory(t);
  const store = createWorkspaceStore({ dataDir: dir });
  t.after(() => store.close());
  const names = () => store.loadWorkspace().projects.map(p => p.name);

  const a = store.createProject({ name: "A" });
  const b = store.createProject({ name: "B" });
  const c = store.createProject({ name: "C" });
  assert.deepEqual(names(), ["A", "B", "C"], "默认按创建顺序");

  // 把 C 插到 A 之前。
  assert.equal(store.reorderProject(c.id, a.id), true);
  assert.deepEqual(names(), ["C", "A", "B"]);

  // beforeId 为 null 表示移到末尾。
  assert.equal(store.reorderProject(c.id, null), true);
  assert.deepEqual(names(), ["A", "B", "C"]);

  // 配色是建组时写进列里的，重排不该改动它。
  const colours = new Map(store.loadWorkspace().projects.map(p => [p.name, p.color]));
  store.reorderProject(b.id, a.id);
  for (const p of store.loadWorkspace().projects) {
    assert.equal(p.color, colours.get(p.name), `${p.name} 的配色不应随排序变化`);
  }

  // 未知的 id 一律拒绝，不得把序列改成半截状态。
  const before = names();
  assert.equal(store.reorderProject("missing", null), false);
  assert.equal(store.reorderProject(a.id, "missing"), false);
  assert.deepEqual(names(), before);

  // 重排写的是持久化的 seq 列，重新打开仍然成立。
  const reopened = createWorkspaceStore({ dataDir: dir });
  try {
    assert.deepEqual(reopened.loadWorkspace().projects.map(p => p.name), before);
  } finally {
    reopened.close();
  }
});

test("启动台的固定端口：存顺序，并且在存储层就把不合法的挡掉", (t) => {
  const store = createWorkspaceStore({ dataDir: directory(t) });
  t.after(() => store.close());

  // 顺序本身就是要存的东西——用户拖出来的排布不能被重排。
  store.setPinnedAppPorts([8080, 3000, 5173]);
  assert.deepEqual(store.loadWorkspace().pinnedAppPorts, [8080, 3000, 5173]);

  /*
    **校验放在这一层，不在 HTTP 那一层。** 这些值来自请求体，而下游会把它们直接拼进
    `/api/app/<端口>/`；只在路由里挡一次的话，任何别的写入路径（以后的批量导入、
    迁移脚本）都会绕过去。
  */
  store.setPinnedAppPorts([0, -1, 70000, 1.5, Number.NaN, 5173, 5173, 65535]);
  assert.deepEqual(store.loadWorkspace().pinnedAppPorts, [5173, 65535],
    "越界、非整数、重复一律去掉，合法的保持原顺序");

  // 上限：一个人不会固定几百个应用，而无上限的列表会被一次坏写入撑爆。
  store.setPinnedAppPorts(Array.from({ length: 200 }, (_, i) => i + 1));
  assert.equal(store.loadWorkspace().pinnedAppPorts.length, 64);

  store.setPinnedAppPorts([]);
  assert.deepEqual(store.loadWorkspace().pinnedAppPorts, []);
});

test("固定端口：库里的值不是经 setter 写进去的时候也不能信", (t) => {
  /*
    写侧总是过一遍校验，所以正常来回跑不到读侧那一段——**变异测试把读侧的校验删掉之后
    所有用例照样绿**。但它不是死代码：手改过的库、旧版本写下的形状、截断的值都会走到
    这里，而这些值下游会被直接拼进 `/api/app/<端口>/`。所以绕开 setter 直接写库来测。

    整份坏掉时回退空表，而不是抛——这些是「记住上次怎么摆」的偏好，宁可丢排布，
    也不该让整个工作区加载失败。
  */
  const dir = directory(t);
  const store = createWorkspaceStore({ dataDir: dir });
  store.close();
  const write = (value: string) => {
    const db = new DatabaseSync(join(dir, "workspace.sqlite"));
    db.prepare("INSERT INTO meta (key, value) VALUES ('pinnedAppPorts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
    db.close();
  };
  const read = () => {
    const opened = createWorkspaceStore({ dataDir: dir });
    try { return opened.loadWorkspace().pinnedAppPorts; } finally { opened.close(); }
  };

  write(JSON.stringify([5173, 0, 99999, "8080", null, 3000]));
  assert.deepEqual(read(), [5173, 3000], "混进来的非法项逐个剔掉，合法的保留");

  for (const broken of ['{"not":"an array"}', 'null', '不是 JSON', '']) {
    write(broken);
    assert.deepEqual(read(), [], `整份坏掉时回退空表：${broken || "（空串）"}`);
  }
});
