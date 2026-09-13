import type { DatabaseSync } from "node:sqlite";
import type { BridgeRecord, BridgeStorage, EventEnvelope } from "@roost/ai-session-bridge";
import { registerConversationWriter, conversationSchema, backfillConversations, protectConversationWrites } from "./conversation-schema.ts";
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
