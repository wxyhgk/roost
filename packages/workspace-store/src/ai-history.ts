import { observeConversation } from "./conversation-schema.ts";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Binding, BridgeEvent, BridgeRecord, EventEnvelope } from "@roost/ai-session-bridge";
import { AiHistoryError, type HistoryCoverage, type HistoryGeneration, type HistoryMessage, type HistoryStore } from "@roost/ai-session-bridge";

export function atomic<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("SAVEPOINT ai_history_write");
  try { const result = fn(); db.exec("RELEASE ai_history_write"); return result; }
  catch (error) { db.exec("ROLLBACK TO ai_history_write; RELEASE ai_history_write"); throw error; }
}
export function historySchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_conversations (id TEXT PRIMARY KEY, cli_id TEXT NOT NULL, native_id TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 1, UNIQUE(cli_id,native_id));
    CREATE TABLE IF NOT EXISTS ai_generations (session_id TEXT NOT NULL,generation TEXT NOT NULL,conversation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,binding_json TEXT NOT NULL,opened_at INTEGER NOT NULL,closed_at INTEGER,upper_bound INTEGER NOT NULL DEFAULT 0,coverage_json TEXT NOT NULL,PRIMARY KEY(session_id,generation),UNIQUE(session_id,ordinal));
    CREATE TABLE IF NOT EXISTS ai_history_messages (conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,seq INTEGER NOT NULL,preview_json TEXT NOT NULL,body_state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,event_id TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(conversation_id,message_id),UNIQUE(conversation_id,seq));
    CREATE TABLE IF NOT EXISTS ai_history_bodies (conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(conversation_id,message_id));
    CREATE TABLE IF NOT EXISTS ai_session_replay (session_id TEXT NOT NULL,generation TEXT NOT NULL,seq INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(session_id,generation,seq));
  `);
  // Upgrade intermediate development databases before creating indexes on new columns.
  const columns=db.prepare("PRAGMA table_info(ai_history_messages)").all() as {name:string}[];
  if(!columns.some(c=>c.name==="event_id"))db.exec("ALTER TABLE ai_history_messages ADD COLUMN event_id TEXT NOT NULL DEFAULT ''");
  if(!columns.some(c=>c.name==="content_hash"))db.exec("ALTER TABLE ai_history_messages ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
  if(!columns.some(c=>c.name==="event_id")||!columns.some(c=>c.name==="content_hash")) {
    const rows=db.prepare("SELECT m.conversation_id,m.message_id,m.preview_json,b.event_json FROM ai_history_messages m LEFT JOIN ai_history_bodies b ON m.conversation_id=b.conversation_id AND m.message_id=b.message_id").all() as {conversation_id:string;message_id:string;preview_json:string;event_json:string|null}[];
    for(const r of rows) {const event=JSON.parse(r.event_json??r.preview_json) as BridgeEvent;db.prepare("UPDATE ai_history_messages SET event_id=?,content_hash=? WHERE conversation_id=? AND message_id=?").run(event.eventId,contentHash(event),r.conversation_id,r.message_id);}
  }
  db.exec("CREATE INDEX IF NOT EXISTS ai_history_event ON ai_history_messages(conversation_id,event_id,revision DESC)");
}
export const conversationId = (binding: Binding) => createHash("sha256").update(JSON.stringify(["local",binding.cliId,binding.nativeSessionId])).digest("hex");
export function writeGeneration(db: DatabaseSync, record: BridgeRecord, migration = false) {
  const b=record.binding, cid=conversationId(b);
  db.prepare("INSERT OR IGNORE INTO ai_conversations(id,cli_id,native_id) VALUES(?,?,?)").run(cid,b.cliId,b.nativeSessionId);
  db.prepare("UPDATE ai_generations SET closed_at=?, upper_bound=(SELECT last_seq FROM ai_conversations WHERE id=conversation_id) WHERE session_id=? AND generation<>? AND closed_at IS NULL").run(b.updatedAt,b.webSessionId,b.generation);
  const coverage: HistoryCoverage={hasGap:!!record.sourceHasGap || (record.transcript?.skipped ?? 0)>0 || (migration && record.droppedThrough>0),transcriptStatus:record.transcript?.status,skippedRecords:record.transcript?.skipped};
  db.prepare(`INSERT INTO ai_generations(session_id,generation,conversation_id,ordinal,binding_json,opened_at,coverage_json)
    VALUES(?,?,?,(SELECT COALESCE(MAX(ordinal),0)+1 FROM ai_generations WHERE session_id=?),?,?,?)
    ON CONFLICT(session_id,generation) DO UPDATE SET binding_json=excluded.binding_json,
    coverage_json=json_set(excluded.coverage_json,'$.hasGap',json(CASE WHEN json_extract(ai_generations.coverage_json,'$.hasGap') OR json_extract(excluded.coverage_json,'$.hasGap') THEN 'true' ELSE 'false' END))`)
    .run(b.webSessionId,b.generation,cid,b.webSessionId,JSON.stringify(b),b.updatedAt,JSON.stringify(coverage));
  observeConversation(db,cid,b);
  return cid;
}
/*
  裁剪超大消息时**保留 parts 的轮廓**。

  parts 是这条消息的结构（调用了哪个工具、参数大概是什么、结果成没成），列表要靠它把
  一次 agent 回合渲染成「文本 + 工具调用」而不是一坨纯文本。原来这里把 parts 整个丢掉，
  于是同一个会话里，小消息能看出工具调用、大消息只剩一段文字——**同一种东西有两种长相，
  而分界线是一个用户看不见的字节数**。

  只留轮廓：每段截到 200 字符、最多 40 段。完整参数和结果仍然只在正文里，按需回读。
*/
const PREVIEW_PART_TEXT = 200, PREVIEW_PARTS = 40;
function outlineParts(parts:unknown) {
  if(!Array.isArray(parts))return undefined;
  return parts.slice(0,PREVIEW_PARTS).map(part=>{
    const p=part as Record<string,unknown>;
    return {type:typeof p.type==="string"?p.type.slice(0,64):undefined,
      name:typeof p.name==="string"?p.name.slice(0,128):undefined,
      toolCallId:typeof p.toolCallId==="string"?p.toolCallId.slice(0,256):undefined,
      text:typeof p.text==="string"?p.text.slice(0,PREVIEW_PART_TEXT):undefined,
      // 改动的真实 hunk 可能很大。轮廓里只留「有改动」这件事，diff 本身留给正文回读。
      ...(p.patch?{patch:{hunks:[],truncated:true}}:{})};
  });
}
function previewJson(event:BridgeEvent) {
  let value=JSON.stringify(event);
  if(Buffer.byteLength(value)<=128*1024)return value;
  const d=event.data as Record<string,unknown>|undefined;
  const small={...event,content:event.content?.slice(0,8192),data:{source:d?.source,nativeMessageId:d?.nativeMessageId,parentId:d?.parentId,detail:d?.detail,parts:outlineParts(d?.parts),truncated:true}};
  value=JSON.stringify(small);
  // Unknown caller metadata never defeats the bounded list-response budget.
  if(Buffer.byteLength(value)>128*1024) return JSON.stringify({eventId:event.eventId,type:event.type,
    role:event.role?.slice(0,128),state:event.state,createdAt:event.createdAt,
    content:event.content?.slice(0,8192),data:{source:typeof d?.source==="string"?d.source.slice(0,128):undefined,truncated:true}});
  return value;
}
function sourceBacked(e:BridgeEvent) { const d=e.data as {detail?:unknown;truncated?:boolean}|undefined; return !!d?.detail && !!d.truncated; }
function contentHash(event:BridgeEvent) {
  const data=event.data && typeof event.data==="object"?{...event.data as Record<string,unknown>}:event.data;
  if(data && typeof data==="object")delete (data as Record<string,unknown>).detail;
  // File location and ingestion time are not changes to the agent-owned content.
  const {createdAt:_,...rest}=event;
  return createHash("sha256").update(JSON.stringify({...rest,data})).digest("hex");
}
export function writeMessages(db:DatabaseSync,cid:string,events:EventEnvelope[],details:BridgeEvent[]=[],messages:BridgeEvent[]=[]) {
  type Old={message_id:string;preview_json:string;body_state:string;revision:number;content_hash:string};
  const latest=(id:string)=>db.prepare("SELECT message_id,preview_json,body_state,revision,content_hash FROM ai_history_messages WHERE conversation_id=? AND event_id=? ORDER BY revision DESC LIMIT 1").get(cid,id) as Old|undefined;
  const full=new Map(details.map(e=>[e.eventId,e]));
  const all=new Map([...events.map(e=>e.event),...messages].filter(e=>e.type==="message").map(e=>[e.eventId,e]));
  for(const e of details) if(e.type==="message"&&!all.has(e.eventId)) {const old=latest(e.eventId);all.set(e.eventId,old&&old.body_state==="source_backed"?JSON.parse(old.preview_json):e);}
  for(const [id,event] of all) {
    const body=full.get(id)??event,state=full.has(id)?"stored":sourceBacked(event)?"source_backed":"stored";
    const preview=previewJson(event),bodyJson=JSON.stringify(body),hash=contentHash(body),old=latest(id);
    if(old) {
      if(old.content_hash===hash)continue;
      const samePreview=contentHash(JSON.parse(old.preview_json))===contentHash(JSON.parse(preview));
      const previousProof=(JSON.parse(old.preview_json).data?.detail as {hash?:unknown}|undefined)?.hash;
      const currentProof=(body.data as {detail?:{hash?:unknown}}|undefined)?.detail?.hash;
      // Enrichment captures the same preview's unavailable full body, never replacing an archived full version.
      if(samePreview && old.body_state==="source_backed" && full.has(id) && typeof previousProof==="string" && previousProof===currentProof) {
        db.prepare("UPDATE ai_history_messages SET body_state='stored',content_hash=? WHERE conversation_id=? AND message_id=?").run(hash,cid,old.message_id);
        db.prepare("UPDATE ai_history_bodies SET event_json=? WHERE conversation_id=? AND message_id=?").run(bodyJson,cid,old.message_id);
        continue;
      }
      if(samePreview && old.body_state==="stored" && !full.has(id))continue;
    }
    const revision=(old?.revision??0)+1,messageId=old?`${id}~r${revision}~${hash.slice(0,16)}`:id;
    const next=db.prepare("UPDATE ai_conversations SET last_seq=last_seq+1,epoch=epoch+? WHERE id=? RETURNING last_seq").get(old?1:0,cid) as {last_seq:number};
    db.prepare("INSERT INTO ai_history_messages VALUES(?,?,?,?,?,?,?,?)").run(cid,messageId,next.last_seq,preview,state,revision,id,hash);
    db.prepare("INSERT INTO ai_history_bodies VALUES(?,?,?)").run(cid,messageId,bodyJson);
    const timestamp=Number.isSafeInteger(event.createdAt)?event.createdAt!:Date.now();
    db.prepare(`UPDATE conversation_catalog SET last_message_at=MAX(COALESCE(last_message_at,?),?),updated_at=MAX(updated_at,?)
      WHERE id=(SELECT conversation_id FROM conversation_sources WHERE legacy_conversation_id=?)`).run(timestamp,timestamp,timestamp,cid);
  }
}

type GenerationRow={session_id:string;generation:string;conversation_id:string;ordinal:number;binding_json:string;opened_at:number;closed_at:number|null;upper_bound:number;coverage_json:string};
const generation=(r:GenerationRow,upper:number):HistoryGeneration=>({webSessionId:r.session_id,generation:r.generation,conversationId:r.conversation_id,ordinal:r.ordinal,binding:JSON.parse(r.binding_json),openedAt:r.opened_at,closedAt:r.closed_at,upperBoundSeq:upper,coverage:JSON.parse(r.coverage_json)});
function limitOf(n:number|undefined) { if(n!==undefined&&(!Number.isSafeInteger(n)||n<1||n>200)) throw new AiHistoryError(400,"invalid_request","limit must be between 1 and 200");return n??50; }
function invalid(message:string):never {throw new AiHistoryError(400,"invalid_request",message);}
export function createHistoryStore(db:DatabaseSync):HistoryStore {
  function row(id:string,gen:string) { const r=db.prepare("SELECT * FROM ai_generations WHERE session_id=? AND generation=?").get(id,gen) as GenerationRow|undefined;if(!r)throw new AiHistoryError(404,"not_found","history generation not found");return r; }
  function meta(r:GenerationRow) {const c=db.prepare("SELECT last_seq,epoch FROM ai_conversations WHERE id=?").get(r.conversation_id) as {last_seq:number;epoch:number};return {upper:r.closed_at===null?c.last_seq:r.upper_bound,epoch:c.epoch};}
  type MessageRow={message_id:string;seq:number;preview_json:string;body_state:HistoryMessage["bodyState"];revision:number};
  const message=(r:MessageRow,event?:string):HistoryMessage=>({messageId:r.message_id,historySeq:r.seq,event:JSON.parse(event??r.preview_json),bodyState:r.body_state,sourceRevision:r.revision});
  return {
    listGenerations(id,opts={}) {
      const limit=limitOf(opts.limit);
      if(opts.beforeOrdinal!==undefined&&(!Number.isSafeInteger(opts.beforeOrdinal)||opts.beforeOrdinal<1))invalid("invalid beforeOrdinal");
      if(!db.prepare("SELECT 1 FROM ai_generations WHERE session_id=? LIMIT 1").get(id))throw new AiHistoryError(404,"not_found","history session not found");
      const rows=db.prepare("SELECT * FROM ai_generations WHERE session_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?").all(id,opts.beforeOrdinal??Number.MAX_SAFE_INTEGER,limit+1) as GenerationRow[];
      return {items:rows.slice(0,limit).map(r=>generation(r,meta(r).upper)),nextBeforeOrdinal:rows.length>limit?rows[limit-1]!.ordinal:null};
    },
    pageMessages(id,gen,opts={}) {
      const limit=limitOf(opts.limit),r=row(id,gen),m=meta(r);let before=m.upper+1,upper=m.upper;
      const scope=createHash("sha256").update(JSON.stringify([id,gen])).digest("hex");
      if(opts.cursor!==undefined) {
        if(typeof opts.cursor!=="string"||opts.cursor.length>2048)invalid("invalid cursor");
        let c:any;try{c=JSON.parse(Buffer.from(opts.cursor,"base64url").toString("utf8"));}catch{invalid("invalid cursor");}
        if(!c||c.v!==1||c.scope!==scope||c.cid!==r.conversation_id||![c.before,c.upper,c.epoch].every(Number.isSafeInteger)||c.before<1||c.upper<0||c.before>c.upper+1||c.upper>m.upper)invalid("cursor does not match history");
        if(c.epoch!==m.epoch)throw new AiHistoryError(409,"history_cursor_expired","history was revised; restart pagination");
        before=c.before;upper=c.upper;
      }
      const rows=db.prepare("SELECT * FROM ai_history_messages WHERE conversation_id=? AND seq<? AND seq<=? ORDER BY seq DESC LIMIT ?").all(r.conversation_id,before,upper,limit+1) as MessageRow[];
      const items:HistoryMessage[]=[];let bytes=2048;
      for(const item of rows.slice(0,limit)) { const value=message(item),size=Buffer.byteLength(JSON.stringify(value));if(bytes+size>512*1024)break;items.push(value);bytes+=size; }
      const last=items.at(-1)?.historySeq??before,hasMore=last>1 && !!db.prepare("SELECT 1 FROM ai_history_messages WHERE conversation_id=? AND seq<? AND seq<=? LIMIT 1").get(r.conversation_id,last,upper);
      const cursor=Buffer.from(JSON.stringify({v:1,scope,cid:r.conversation_id,before:last,upper,epoch:m.epoch})).toString("base64url");
      return {items:items.reverse(),nextCursor:hasMore?cursor:null,hasMore,upperBoundSeq:upper,historyEpoch:m.epoch,conversationId:r.conversation_id,coverage:JSON.parse(r.coverage_json)};
    },
    getMessage(id,gen,messageId) {
      const r=row(id,gen),m=meta(r);
      const item=db.prepare("SELECT * FROM ai_history_messages WHERE conversation_id=? AND message_id=? AND seq<=?").get(r.conversation_id,messageId,m.upper) as MessageRow|undefined;
      if(!item)throw new AiHistoryError(404,"not_found","history message not found");
      const body=db.prepare("SELECT event_json FROM ai_history_bodies WHERE conversation_id=? AND message_id=?").get(r.conversation_id,messageId) as {event_json:string}|undefined;
      const result=message(item,body?.event_json);if(!body&&item.body_state!=="source_backed")result.bodyState="unavailable";return result;
    },
  };
}
