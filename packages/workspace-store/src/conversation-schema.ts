import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Binding } from "@roost/ai-session-bridge";

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
export function observeConversation(db: DatabaseSync, cid: string, binding?: Binding) {
  const native = db.prepare("SELECT cli_id,native_id FROM ai_conversations WHERE id=?").get(cid) as {cli_id:string;native_id:string};
  const old = db.prepare("SELECT conversation_id FROM conversation_sources WHERE legacy_conversation_id=?").get(cid) as {conversation_id:string}|undefined;
  const hasSessions = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  const session = binding && hasSessions ? db.prepare("SELECT title,project_id,cwd FROM sessions WHERE id=?").get(binding.webSessionId) as {title:string;project_id:string|null;cwd:string}|undefined : undefined;
  const timestamp = binding?.updatedAt ?? Date.now();
  if (old) {
    db.prepare("UPDATE conversation_sources SET cwd=COALESCE(?,cwd),transcript_path=COALESCE(?,transcript_path),observed_at=MAX(observed_at,?) WHERE legacy_conversation_id=?")
      .run(session?.cwd ?? null,binding?.transcriptPath ?? null,timestamp,cid);
    return old.conversation_id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO conversation_catalog(id,title,title_origin,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run(id,
      // 默认标题不是标题：拿它当名字会让整个目录长得一模一样，认不出哪条是哪条。
      isDefaultSessionTitle(session?.title) ? `${native.cli_id} ${native.native_id.slice(0,16)}` : session!.title.trim().slice(0,200),
      isDefaultSessionTitle(session?.title) ? "fallback" : "native",
      session?.project_id ?? null,timestamp,timestamp);
  db.prepare(`INSERT INTO conversation_sources(id,conversation_id,legacy_conversation_id,origin_scope,cli_id,native_session_id,cwd,transcript_path,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(),id,cid,"legacy-local",native.cli_id,native.native_id,session?.cwd ?? null,binding?.transcriptPath ?? null,timestamp);
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
