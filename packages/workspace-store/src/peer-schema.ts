import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.ts";

export function peerSchema(db:DatabaseSync) {
  transaction(db,()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS peer_messages(
      id TEXT PRIMARY KEY,sender_kind TEXT NOT NULL CHECK(sender_kind IN ('user','agent')),
      sender_conversation_id TEXT,sender_run_id TEXT,sender_scope TEXT NOT NULL,
      request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,recipient_id TEXT NOT NULL,
      body TEXT NOT NULL,format TEXT NOT NULL,created_at INTEGER NOT NULL,in_reply_to TEXT,
      UNIQUE(sender_scope,request_id));
      CREATE TABLE IF NOT EXISTS peer_deliveries(
        enqueue_seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
        message_id TEXT NOT NULL,recipient_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','dispatching','accepted','failed','uncertain','cancelled')),
        reason TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        target_run_id TEXT,target_source_id TEXT,target_owner_epoch INTEGER,
        command_session_id TEXT,command_request_id TEXT NOT NULL UNIQUE,
        terminal_instance_id TEXT,generation TEXT,native_session_id TEXT,command_digest TEXT,
        accepted_native_message_id TEXT,accepted_at INTEGER,UNIQUE(message_id,recipient_id));
      CREATE INDEX IF NOT EXISTS peer_delivery_queue ON peer_deliveries(recipient_id,state,enqueue_seq);
      CREATE INDEX IF NOT EXISTS peer_message_sender ON peer_messages(sender_conversation_id,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS peer_native_receipt ON peer_deliveries(target_source_id,accepted_native_message_id)
        WHERE accepted_native_message_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS peer_message_immutable BEFORE UPDATE ON peer_messages
        BEGIN SELECT RAISE(ABORT,'peer messages are immutable'); END;`);
    for(const table of ["peer_messages","peer_deliveries"]) {
      for(const operation of ["INSERT","UPDATE","DELETE"]) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_writer_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
          BEGIN SELECT CASE WHEN diy_conversation_writer_v1() IS NOT 1 THEN RAISE(ABORT,'peer storage requires upgraded writer') END; END;`);
      }
    }
  });
}
