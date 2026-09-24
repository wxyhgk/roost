import type { DatabaseSync } from "node:sqlite";
import type { BridgeRecord, BridgeStorage, EventEnvelope } from "@roost/ai-session-bridge";
import { registerConversationWriter, conversationSchema, backfillConversations, protectConversationWrites, refreshDerived } from "./conversation-schema.ts";
import { transaction } from "./database.ts";
import { atomic, createHistoryStore, historySchema, writeGeneration, writeMessages } from "./ai-history.ts";

export function createAiSessionStorage(db: DatabaseSync): BridgeStorage {
  registerConversationWriter(db);
  db.exec("CREATE TABLE IF NOT EXISTS ai_session_records (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ai_session_native_identity ON ai_session_records (
    json_extract(record_json,'$.binding.cliId'), json_extract(record_json,'$.binding.nativeSessionId'))`);
  transaction(db,()=>{
    historySchema(db);
    conversationSchema(db);
    db.exec("DROP TRIGGER IF EXISTS ai_history_writer_insert; DROP TRIGGER IF EXISTS ai_history_writer_update");
    db.exec("CREATE TABLE IF NOT EXISTS ai_history_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ai_history_legacy_records(session_id TEXT PRIMARY KEY,record_json TEXT NOT NULL)");
    if(!db.prepare("SELECT 1 FROM ai_history_meta WHERE key='schema.v1'").get()) {
      const rows=db.prepare("SELECT session_id,record_json FROM ai_session_records").all() as {session_id:string;record_json:string}[];
      for(const row of rows) {
        db.prepare("INSERT OR IGNORE INTO ai_history_legacy_records VALUES(?,?)").run(row.session_id,row.record_json);
        const record=JSON.parse(row.record_json) as BridgeRecord;
        record.binding.generation??="legacy-"+record.binding.terminalInstanceId;
        record.binding.revision??=0;
        record.hasSeenMessages??=record.droppedThrough>0 || record.events.some(e=>e.event.type==="message");
        for(const e of record.events)e.generation??=record.binding.generation;
        const cid=writeGeneration(db,record,true);writeMessages(db,cid,record.events);
        for(const e of record.events)db.prepare("INSERT OR IGNORE INTO ai_session_replay VALUES(?,?,?,?)").run(row.session_id,e.generation,e.seq,JSON.stringify(e));
        db.prepare("UPDATE ai_session_records SET record_json=? WHERE session_id=?").run(JSON.stringify({...record,events:undefined,storageFormat:3}),row.session_id);
      }
      db.prepare("INSERT INTO ai_history_meta VALUES('schema.v1','1')").run();
    }
    if (!db.prepare("SELECT 1 FROM ai_history_meta WHERE key='schema.conversations.v1'").get()) {
      backfillConversations(db);
      db.exec("UPDATE ai_session_records SET record_json=json_set(record_json,'$.storageFormat',3)");
      db.prepare("INSERT INTO ai_history_meta VALUES('schema.conversations.v1','1')").run();
    }
    /*
      存量修正：把默认终端标题冒充的 `native` 改回 `fallback`。

      入库规则原来是「sessions.title 非空就当真标题、盖章 native」，而建终端一律写死
      "Terminal"，于是整个目录清一色叫 Terminal 还自称来源确凿，界面因此连「自动命名」
      的提示都不打。规则已在 `conversation-schema.ts` 改掉，但那只作用于新观察到的对话。

      **只改来源标记，不动标题文字**：文字是用户看得见的东西，重写它属于另一件事；
      标记改对之后，界面就能自己决定退回显示「这条对话讲了什么」。
    */
    if (!db.prepare("SELECT 1 FROM ai_history_meta WHERE key='schema.conversation-title-origin.v1'").get()) {
      db.exec(`UPDATE conversation_catalog SET title_origin='fallback'
        WHERE title_origin='native' AND (TRIM(title)='' OR TRIM(title)='Terminal' OR TRIM(title) GLOB 'Session [0-9]*')`);
      db.prepare("INSERT INTO ai_history_meta VALUES('schema.conversation-title-origin.v1','1')").run();
    }
    /*
      存量回填：把名字和归属从「创建那一刻的终端快照」改成「从对话自己推」。

      这条要跑一次全量，是因为改动只作用于**之后**被观测到的对话，而一条早就不再活跃的
      对话可能再也不会被观测——那正是问题最重的一批：实测这台机器 21 条里 14 条标题是
      `claude 3749983a-1594-47`、10 条永远没有归属。

      `observeConversation` 里已经带了 `refreshDerived`，所以这里直接重放一遍即可。
      **只动标题和归属，不碰任何正文**；而且 `refreshDerived` 自己会让开人手动设过的
      （title_origin='user' / project_origin='user'）。
    */
    if (!db.prepare("SELECT 1 FROM ai_history_meta WHERE key='schema.conversation-derived-metadata.v1'").get()) {
      backfillConversations(db);
      db.prepare("INSERT INTO ai_history_meta VALUES('schema.conversation-derived-metadata.v1','1')").run();
    }
    protectConversationWrites(db);
    // Reject old gateway writers instead of silently accepting writes that omit durable history.
    db.exec(`CREATE TRIGGER IF NOT EXISTS ai_history_writer_insert BEFORE INSERT ON ai_session_records
      WHEN COALESCE(json_extract(NEW.record_json,'$.storageFormat'),0)<>3 BEGIN SELECT RAISE(ABORT,'AI storage format requires upgraded gateway'); END;
      CREATE TRIGGER IF NOT EXISTS ai_history_writer_update BEFORE UPDATE ON ai_session_records
      WHEN COALESCE(json_extract(NEW.record_json,'$.storageFormat'),0)<>3 BEGIN SELECT RAISE(ABORT,'AI storage format requires upgraded gateway'); END;`);
  });
  return {
    history:createHistoryStore(db),
    list: () => (db.prepare("SELECT record_json FROM ai_session_records").all() as { record_json: string }[])
      .map(row => { const {storageFormat:_,...record}=JSON.parse(row.record_json); return {...record,events:[]} as BridgeRecord; }),
    loadEvents:(id,generation,throughSeq)=>(db.prepare("SELECT event_json FROM ai_session_replay WHERE session_id=? AND generation=? AND seq<=? ORDER BY seq").all(id,generation,throughSeq) as {event_json:string}[]).map(r=>JSON.parse(r.event_json) as EventEnvelope),
    save: (record, expectedRevision,changes) => atomic(db,()=>{
      const id=record.binding.webSessionId;
      const result = db.prepare(`INSERT INTO ai_session_records SELECT ?, ? WHERE ?=0 OR EXISTS(SELECT 1 FROM ai_session_records WHERE session_id=?)
        ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json
        WHERE COALESCE(json_extract(ai_session_records.record_json,'$.binding.revision'),0)=?`)
        .run(id, JSON.stringify({...record,events:undefined,storageFormat:3}), expectedRevision ?? 0, id, expectedRevision ?? 0);
      if (result.changes !== 1) throw new Error("AI binding concurrent writer conflict");
      const cid=writeGeneration(db,record);
      writeMessages(db,cid,changes ? changes.events??[] : record.events,changes?.details,changes?.messages);
      /*
        **消息写完之后再推一次标题。** `writeGeneration` 里面那次跑在 `writeMessages`
        之前，所以一条全新对话的第一条消息那时还不在库里——标题会慢一条消息才出现，
        目录里先闪一行 `omp derived-title`。用例当场抓到的就是这个。
      */
      const catalog=db.prepare("SELECT conversation_id FROM conversation_sources WHERE legacy_conversation_id=?").get(cid) as {conversation_id:string}|undefined;
      if(catalog)refreshDerived(db,catalog.conversation_id,cid,record.binding.updatedAt??Date.now());
      // Sync only bounded replay IDs; metadata and history bodies are not rewritten.
      const keep=new Set(record.events.map(e=>`${e.generation}:${e.seq}`));
      const rows=db.prepare("SELECT generation,seq FROM ai_session_replay WHERE session_id=?").all(id) as {generation:string;seq:number}[];
      for(const r of rows)if(!keep.has(`${r.generation}:${r.seq}`))db.prepare("DELETE FROM ai_session_replay WHERE session_id=? AND generation=? AND seq=?").run(id,r.generation,r.seq);
      const existing=new Set(rows.map(r=>`${r.generation}:${r.seq}`));
      for(const e of record.events)if(!existing.has(`${e.generation}:${e.seq}`))db.prepare("INSERT INTO ai_session_replay VALUES(?,?,?,?)").run(id,e.generation,e.seq,JSON.stringify(e));
    }),
    remove: id => atomic(db,()=>{
      db.prepare("DELETE FROM ai_session_records WHERE session_id=?").run(id);
      db.prepare("DELETE FROM ai_history_legacy_records WHERE session_id=?").run(id);
      db.prepare("DELETE FROM ai_session_replay WHERE session_id=?").run(id);
      // A terminal is only an execution reference. Preserve its generation bounds
      // and all independent conversation history after the terminal is removed.
      db.prepare(`UPDATE ai_generations SET closed_at=COALESCE(closed_at,?),
        upper_bound=CASE WHEN closed_at IS NULL THEN (SELECT last_seq FROM ai_conversations WHERE id=conversation_id) ELSE upper_bound END
        WHERE session_id=?`).run(Date.now(),id);
    }),
  };
}
