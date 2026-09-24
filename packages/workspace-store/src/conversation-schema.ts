import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Binding } from "@roost/ai-session-bridge";
import { deriveTitle, titleWins, type ProjectOrigin, type TitleOrigin } from "./conversation-identity.ts";

// This capability is deliberately connection-local: already-running old writers
// cannot bypass the schema upgrade by retaining their old SQLite connection.
//
// 项目改名成 Roost 时**没有**跟着改这个名字，这是有意的：下面的触发器是
// CREATE TRIGGER IF NOT EXISTS，已有数据库里的触发器不会被重建，它们的函数名
// 永远停在写入时的那一个。改了名字，新连接注册的是新函数而旧触发器还在调旧的，
// 那几张表的每一次写入都会 ABORT。而它本来也不是品牌，是个「这个连接是升级过的
// 写入者」的能力令牌，版本号就在名字里。真要改得连带重建全部触发器。
export function registerConversationWriter(db: DatabaseSync) {
  db.function("diy_conversation_writer_v1", () => 1);
}
export function conversationSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_catalog (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, title_origin TEXT NOT NULL,
    project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_message_at INTEGER, archived_at INTEGER, trashed_at INTEGER, pinned_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1, forked_from_id TEXT);
    CREATE TABLE IF NOT EXISTS conversation_sources (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE,
      legacy_conversation_id TEXT NOT NULL UNIQUE, origin_scope TEXT NOT NULL CHECK(origin_scope='legacy-local'),
      cli_id TEXT NOT NULL, native_session_id TEXT NOT NULL, cwd TEXT, transcript_path TEXT,
      observed_at INTEGER NOT NULL, UNIQUE(origin_scope,cli_id,native_session_id));
    CREATE INDEX IF NOT EXISTS conversation_catalog_list ON conversation_catalog(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS conversation_catalog_project ON conversation_catalog(project_id);`);
  /*
    归属的来源。**加这一列才敢重算归属**：原来分不出「这个分组是人自己选的，还是建对话
    时从终端捡来的」，一重算就会把人手动的选择冲掉。`title_origin` 早就有这一格，归属
    没有，于是归属只好定死在创建那一刻——21 条里 10 条因此永远为空。

    存量：已经有值的当成 `user`（不知道来源就不动它），为空的当成 `derived`。
    `ALTER TABLE ADD COLUMN` 在已经有这一列时会抛，所以先看一眼 pragma。
  */
  const columns = db.prepare("SELECT name FROM pragma_table_info('conversation_catalog')").all() as { name: string }[];
  if (!columns.some(column => column.name === "project_origin")) {
    db.exec("ALTER TABLE conversation_catalog ADD COLUMN project_origin TEXT NOT NULL DEFAULT 'derived'");
    db.exec("UPDATE conversation_catalog SET project_origin='user' WHERE project_id IS NOT NULL");
  }
}

/**
 * 这条对话现在归哪个分组——**从它跑过的终端推，不从建它那一刻的终端拿**。
 *
 * 取的是 `ai_generations`：它记着每一代「这条对话在哪个终端里跑」，**而且是在同一个事务里
 * 由这一层自己写的**。第一版取的是 `conversation_runs`，那张表由后端写，存储层单独跑的
 * 时候根本是空的——用例当场就抓出来了。
 *
 * 取最近一代、且那个终端现在还有归属的那个分组。「它属于哪儿」因此是个随时能重算的问题，
 * 而不是要在创建时猜准的一次性判断。
 *
 * 推不出来给 null，**不保留旧值**：那条终端被删掉或移出分组之后，旧归属就是个已经不成立
 * 的说法，留着比空着更容易把人带偏。
 */
function derivedProject(db: DatabaseSync, legacyId: string): string | null | undefined {
  /*
    `sessions` 不一定在：AI 历史这一层可以脱离完整的工作区单独建起来（测试里就是这么用的）。
    查不到时返回 `undefined` 表示「这次推不出结论」，和 `null`（「推出来了，就是没有归属」）
    严格分开——把前者当成后者会在没有工作区的上下文里把已有的归属抹掉。
  */
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get()) return undefined;
  // 上面这句返回 `undefined` 而不是 `null` 是防御性的：变异测试显示改成 `null` 所有用例
  // 照样绿，因为没有 sessions 表时也就没有任何途径能把 project_id 设成非空，两者到不了
  // 不同的结果。保留 `undefined` 是因为「查不到」和「查到了是空」本来就不是一件事——
  // 以后多一条写入路径时，这一格已经是对的。
  const row = db.prepare(`SELECT s.project_id AS project_id FROM ai_generations g
    JOIN sessions s ON s.id = g.session_id
    WHERE g.conversation_id = ?
    ORDER BY g.opened_at DESC, g.ordinal DESC LIMIT 1`).get(legacyId) as { project_id: string | null } | undefined;
  return row ? row.project_id : null;
}

/** 这条对话的第一条用户消息，用来推标题。 */
function firstUserText(db: DatabaseSync, legacyId: string): string | null {
  const row = db.prepare(`SELECT preview_json FROM ai_history_messages
    WHERE conversation_id = ? AND json_extract(preview_json,'$.role') = 'user'
    ORDER BY seq ASC LIMIT 1`).get(legacyId) as { preview_json: string } | undefined;
  if (!row) return null;
  try {
    const content = (JSON.parse(row.preview_json) as { content?: unknown }).content;
    return typeof content === "string" ? content : null;
  } catch { return null; }
}

/**
 * 每次观测都把能重算的重算一遍。
 *
 * 这是这次改动的核心：元数据不再是创建那一刻的快照。归属按运行记录重算（除非人自己
 * 选过），标题在还是兜底值时用第一条用户消息顶上。
 */
export function refreshDerived(db: DatabaseSync, conversationId: string, legacyId: string, timestamp: number) {
  const row = db.prepare("SELECT title_origin,project_origin,project_id FROM conversation_catalog WHERE id=?")
    .get(conversationId) as { title_origin: TitleOrigin; project_origin: ProjectOrigin; project_id: string | null } | undefined;
  if (!row) return;
  if (row.project_origin !== "user") {
    const project = derivedProject(db, legacyId);
    if (project !== undefined && project !== row.project_id) {
      db.prepare("UPDATE conversation_catalog SET project_id=?,revision=revision+1,updated_at=MAX(updated_at,?) WHERE id=?")
        .run(project, timestamp, conversationId);
    }
  }
  if (!titleWins("derived", row.title_origin)) return;
  const title = deriveTitle(firstUserText(db, legacyId));
  if (!title) return;
  db.prepare("UPDATE conversation_catalog SET title=?,title_origin='derived',revision=revision+1,updated_at=MAX(updated_at,?) WHERE id=? AND title<>?")
    .run(title, timestamp, conversationId, title);
}
/**
 * 终端标题是不是「默认的」——也就是没人真正给它起过名。
 *
 * 建终端时 `frontend/src/shared/store/index.ts` 一律写死 `title = "Terminal"`，历史上还有
 * `Session 3` 这种编号。终端界面早就知道这件事：`frontend/src/shared/sessionTitle.ts` 把
 * 这两种形状当成「不是真名字」，显示时退回工作目录的最后一段。
 *
 * 对话入库这边原来没有这条规则，于是 `sessions.title` 只要非空就被当成真标题、还盖章
 * `native`（本意是「CLI 自己给的名字」）。实测结果是**整个目录 7 条全叫「Terminal」**，
 * 而且因为标成了 native，界面连「自动命名」那个提示都不会打——把一个兜底值说成了来源确凿。
 */
export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim() ?? "";
  return !trimmed || trimmed === "Terminal" || /^Session \d+$/.test(trimmed);
}
/**
 * 把 CLI 自己给这条对话起的名字接上来。
 *
 * claude 会给会话生成标题，写在转录里（`{"type":"ai-title","aiTitle":"…"}`），适配器把它
 * 带在 checkpoint 的 state 上。这才是 `titleOrigin: "native"`（「CLI 自己给的名字」）本来
 * 要表达的东西——在此之前那个值一直被拿去标终端标题，名不副实。
 *
 * 两条边界：
 *
 * - **绝不覆盖用户改过的标题**（`title_origin='user'`）。用户重命名过就是最终答案。
 * - 已经是 `native` 时仍然跟着更新：claude 会重新生成标题，跟着它走才叫同步。但标题没变
 *   时不写，免得每次 ingest 都白白推高 revision、把别人手上的版本号撞成过期。
 */
function applyNativeTitle(db: DatabaseSync, conversationId: string, webSessionId: string) {
  const row = db.prepare("SELECT json_extract(record_json,'$.transcript.state.aiTitle') AS title FROM ai_session_records WHERE session_id=?")
    .get(webSessionId) as { title?: unknown } | undefined;
  const title = typeof row?.title === "string" ? row.title.trim().slice(0, 200) : "";
  if (!title) return;
  db.prepare(`UPDATE conversation_catalog SET title=?,title_origin='native',revision=revision+1,updated_at=?
    WHERE id=? AND title_origin<>'user' AND title<>?`).run(title, Date.now(), conversationId, title);
}
export function observeConversation(db: DatabaseSync, cid: string, binding?: Binding) {
  const native = db.prepare("SELECT cli_id,native_id FROM ai_conversations WHERE id=?").get(cid) as {cli_id:string;native_id:string};
  const old = db.prepare("SELECT conversation_id FROM conversation_sources WHERE legacy_conversation_id=?").get(cid) as {conversation_id:string}|undefined;
  const hasSessions = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  const session = binding && hasSessions ? db.prepare("SELECT title,project_id,cwd FROM sessions WHERE id=?").get(binding.webSessionId) as {title:string;project_id:string|null;cwd:string}|undefined : undefined;
  const timestamp = binding?.updatedAt ?? Date.now();
  if (old) {
    db.prepare("UPDATE conversation_sources SET cwd=COALESCE(?,cwd),transcript_path=COALESCE(?,transcript_path),observed_at=MAX(observed_at,?) WHERE legacy_conversation_id=?")
      .run(session?.cwd ?? null,binding?.transcriptPath ?? null,timestamp,cid);
    // 建的时候转录还没读过，标题只能在后续每次 ingest 时补上——这里正是那个时机。
    if (binding) applyNativeTitle(db, old.conversation_id, binding.webSessionId);
    // 归属和兜底标题每次都重算：它们不该停在创建那一刻看到的终端上。
    refreshDerived(db, old.conversation_id, cid, timestamp);
    return old.conversation_id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO conversation_catalog(id,title,title_origin,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run(id,
      // 默认标题不是标题：拿它当名字会让整个目录长得一模一样，认不出哪条是哪条。
      isDefaultSessionTitle(session?.title) ? `${native.cli_id} ${native.native_id.slice(0,16)}` : session!.title.trim().slice(0,200),
      isDefaultSessionTitle(session?.title) ? "fallback" : "native",
      // 归属留空，紧接着由 refreshDerived 按运行记录推——从终端直接抄是这次要改掉的那件事。
      null,timestamp,timestamp);
  db.prepare(`INSERT INTO conversation_sources(id,conversation_id,legacy_conversation_id,origin_scope,cli_id,native_session_id,cwd,transcript_path,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(),id,cid,"legacy-local",native.cli_id,native.native_id,session?.cwd ?? null,binding?.transcriptPath ?? null,timestamp);
  /*
    刚建出来就先推一次。**这条对话可能早就有正文了**——把一段已有的 CLI 会话第一次纳进来
    时就是这样，而那时候等「下一次观测」才有名字，目录里会先出现一行 `claude 3749…`。
  */
  refreshDerived(db, id, cid, timestamp);
  return id;
}
export function backfillConversations(db: DatabaseSync) {
  const rows = db.prepare("SELECT id FROM ai_conversations").all() as {id:string}[];
  for (const {id} of rows) {
    const generation = db.prepare("SELECT binding_json FROM ai_generations WHERE conversation_id=? ORDER BY opened_at DESC,ordinal DESC LIMIT 1").get(id) as {binding_json:string}|undefined;
    observeConversation(db,id,generation ? JSON.parse(generation.binding_json) : undefined);
    const times = db.prepare("SELECT MIN(opened_at) AS created,MAX(opened_at) AS updated FROM ai_generations WHERE conversation_id=?").get(id) as {created:number|null;updated:number|null};
    const latest = db.prepare("SELECT MAX(CAST(json_extract(preview_json,'$.createdAt') AS INTEGER)) AS last FROM ai_history_messages WHERE conversation_id=?").get(id) as {last:number|null};
    db.prepare("UPDATE conversation_catalog SET created_at=COALESCE(?,created_at),updated_at=MAX(updated_at,COALESCE(?,updated_at),COALESCE(?,updated_at)),last_message_at=? WHERE id=(SELECT conversation_id FROM conversation_sources WHERE legacy_conversation_id=?)")
      .run(times.created,times.updated,latest.last,latest.last,id);
  }
}
export function protectConversationWrites(db: DatabaseSync) {
  for (const table of ["ai_conversations","ai_generations","ai_history_messages","ai_history_bodies","ai_session_records","ai_history_legacy_records","conversation_catalog","conversation_sources"]) {
    for (const operation of ["INSERT","UPDATE","DELETE"]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_conversation_writer_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
        WHEN diy_conversation_writer_v1() <> 1 BEGIN SELECT RAISE(ABORT,'conversation storage requires upgraded writer'); END;`);
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_commands'").get()) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS conversation_command_delete_guard BEFORE DELETE ON ai_commands
      WHEN diy_conversation_writer_v1() <> 1 BEGIN SELECT RAISE(ABORT,'conversation storage requires upgraded writer'); END;`);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS conversation_project_delete_guard BEFORE DELETE ON projects
      WHEN diy_conversation_writer_v1() <> 1 BEGIN SELECT RAISE(ABORT,'conversation storage requires upgraded writer'); END;`);
  }
}
