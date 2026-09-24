import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { HistoryCoverage, HistoryMessage, HistoryPage } from "@roost/ai-session-bridge";
import { atomic } from "./ai-history.ts";
import { transaction } from "./database.ts";
import { createConversationLinks, hasConversationRuns, validateTerminalFilter } from "./conversation-links.ts";
import { createConversationPreviews } from './conversation-preview.ts';
import { ConversationError, type ConversationListItem, type ConversationListOptions, type ConversationPatch, type ConversationRecord } from "./conversation-types.ts";

type CatalogRow = {
  id:string;title:string;title_origin:ConversationRecord["titleOrigin"];project_id:string|null;
  created_at:number;updated_at:number;last_message_at:number|null;archived_at:number|null;trashed_at:number|null;pinned_at:number|null;revision:number;forked_from_id:string|null;
  source_id:string;legacy_conversation_id:string;cli_id:string;native_session_id:string;cwd:string|null;transcript_path:string|null;observed_at:number;
};
type MessageRow = {message_id:string;seq:number;preview_json:string;body_state:HistoryMessage["bodyState"];revision:number};
const catalogFrom = "FROM conversation_catalog c JOIN conversation_sources s ON s.conversation_id=c.id";
const select = `SELECT c.*,s.id AS source_id,s.legacy_conversation_id,s.cli_id,s.native_session_id,s.cwd,s.transcript_path,s.observed_at ${catalogFrom}`;
function invalid(message:string):never { throw new ConversationError(400,"invalid_request",message); }
function limitOf(n:number|undefined) { if(n!==undefined&&(!Number.isSafeInteger(n)||n<1||n>200))invalid("limit must be between 1 and 200"); return n??50; }
function decode(cursor:string) {
  if(typeof cursor!=="string"||cursor.length>2048)invalid("invalid cursor");
  try { const value:unknown=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")); if(!value||typeof value!=="object"||Array.isArray(value))invalid("invalid cursor");return value as Record<string,unknown>; }
  catch { return invalid("invalid cursor"); }
}
const encode = (value:unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const historyMessage = (row:MessageRow,body?:string):HistoryMessage => ({messageId:row.message_id,historySeq:row.seq,event:JSON.parse(body??row.preview_json),bodyState:row.body_state,sourceRevision:row.revision});

export function createConversations(db:DatabaseSync) {
  const firstUserPreviews = createConversationPreviews(db);
  function coverage(cid:string):HistoryCoverage {
    const rows=db.prepare("SELECT coverage_json FROM ai_generations WHERE conversation_id=? ORDER BY opened_at DESC,ordinal DESC").all(cid) as {coverage_json:string}[];
    const all=rows.map(r=>JSON.parse(r.coverage_json) as HistoryCoverage);
    return {...all[0],hasGap:all.some(c=>c.hasGap)};
  }
  function record(r:CatalogRow):ConversationRecord {
    return {id:r.id,title:r.title,titleOrigin:r.title_origin,projectId:r.project_id,createdAt:r.created_at,updatedAt:r.updated_at,lastMessageAt:r.last_message_at,
      archivedAt:r.archived_at,trashedAt:r.trashed_at,pinnedAt:r.pinned_at,revision:r.revision,forkedFromId:r.forked_from_id,
      source:{id:r.source_id,conversationId:r.id,legacyConversationId:r.legacy_conversation_id,originScope:"legacy-local",cliId:r.cli_id,nativeSessionId:r.native_session_id,
        cwd:r.cwd,transcriptPath:r.transcript_path,locatorStatus:"unverified",observedAt:r.observed_at,coverage:coverage(r.legacy_conversation_id)}};
  }
  function row(id:string):CatalogRow {
    const found=db.prepare(`${select} WHERE c.id=?`).get(id) as CatalogRow|undefined;
    if(!found)throw new ConversationError(404,"not_found","conversation not found");return found;
  }
  function get(id:string) { return record(row(id)); }
  function findBySource(cliId:string,nativeSessionId:string) {
    const found=db.prepare(`${select} WHERE s.cli_id=? AND s.native_session_id=? AND c.trashed_at IS NULL LIMIT 1`).get(cliId,nativeSessionId) as CatalogRow|undefined;
    return found ? record(found) : null;
  }
  function list(opts:ConversationListOptions={}) {
    // Activity fingerprint and page must observe the same committed database
    // snapshot; otherwise an intervening message could produce an invalid cursor.
    return atomic(db,()=>listSnapshot(opts));
  }
  function listSnapshot(opts:ConversationListOptions) {
    validateTerminalFilter(opts.terminalId);
    const limit=limitOf(opts.limit),state=opts.state??"active",q=opts.q??"",sort=opts.sort??"created";
    if(sort!=="created"&&sort!=="activity")invalid("invalid sort");
    if(!["active","archived","trashed","all"].includes(state))invalid("invalid state");
    if(typeof q!=="string"||q.length>200)invalid("q must be a string of at most 200 characters");
    if(opts.projectId!==undefined&&opts.projectId!==null&&(typeof opts.projectId!=="string"||!opts.projectId))invalid("invalid projectId");
    const clauses:string[]=[],args:SQLInputValue[]=[];
    if(state==="active")clauses.push("c.archived_at IS NULL AND c.trashed_at IS NULL");
    if(state==="archived")clauses.push("c.archived_at IS NOT NULL AND c.trashed_at IS NULL");
    if(state==="trashed")clauses.push("c.trashed_at IS NOT NULL");
    if(opts.projectId!==undefined) {clauses.push("c.project_id IS ?");args.push(opts.projectId);}
    if(opts.terminalId!==undefined) {
      const withRuns=hasConversationRuns(db);
      clauses.push(`(EXISTS(SELECT 1 FROM ai_generations g WHERE g.conversation_id=s.legacy_conversation_id AND g.session_id=?)
        ${withRuns?"OR EXISTS(SELECT 1 FROM conversation_runs r WHERE r.conversation_id=c.id AND r.source_id=s.id AND r.web_session_id=?)":""})`);
      args.push(opts.terminalId);if(withRuns)args.push(opts.terminalId);
    }
    if(q) {clauses.push(`(instr(lower(c.title),lower(?))>0 OR EXISTS(
      SELECT 1 FROM ai_history_messages m LEFT JOIN ai_history_bodies b
        ON b.conversation_id=m.conversation_id AND b.message_id=m.message_id
      WHERE m.conversation_id=s.legacy_conversation_id
        AND instr(lower(COALESCE(json_extract(b.event_json,'$.content'),json_extract(m.preview_json,'$.content'),'')),lower(?))>0))`);args.push(q,q);}
    const scopeParts:unknown[]=[state,opts.projectId===undefined?false:opts.projectId,q];
    if(opts.terminalId!==undefined)scopeParts.push({terminalId:opts.terminalId});
    if(sort==="activity")scopeParts.push({sort});
    const scope=createHash("sha256").update(JSON.stringify(scopeParts)).digest("hex");
    let fingerprint:string|undefined;
    if(sort==="activity") {
      const digest=createHash("sha256");
      // Scan lightweight fields only. Including matching IDs catches membership
      // changes; sequence/epoch catches messages that retain the same timestamp.
      const matching=db.prepare(`SELECT c.id,COALESCE(c.last_message_at,c.created_at) AS activity,c.revision,
        a.last_seq,a.epoch ${catalogFrom} JOIN ai_conversations a ON a.id=s.legacy_conversation_id
        ${clauses.length?`WHERE ${clauses.join(" AND ")}`:""} ORDER BY c.id`).iterate(...args);
      for(const item of matching)digest.update(JSON.stringify(item)).update("\n");
      fingerprint=digest.digest("hex");
    }
    const orderColumn=sort==="activity"?"COALESCE(c.last_message_at,c.created_at)":"c.created_at";
    if(opts.cursor!==undefined) {
      const cursor=decode(opts.cursor);
      const position=sort==="activity"?cursor.activity:cursor.created;
      if(cursor.v!==1||cursor.scope!==scope||!Number.isSafeInteger(position)||typeof cursor.id!=="string")invalid("cursor does not match conversation list");
      if(sort==="activity") {
        if(typeof cursor.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(cursor.fingerprint))invalid("cursor does not match conversation list");
        if(cursor.fingerprint!==fingerprint)throw new ConversationError(409,"list_changed","conversation list changed; refresh from the first page");
      }
      clauses.push(`(${orderColumn}<? OR (${orderColumn}=? AND c.id<?))`);args.push(position as number,position as number,cursor.id);
    }
    const rows=db.prepare(`${select}${clauses.length?` WHERE ${clauses.join(" AND ")}`:""} ORDER BY ${orderColumn} DESC,c.id DESC LIMIT ?`).all(...args,limit+1) as CatalogRow[];
    const page=rows.slice(0,limit);
    const previews=firstUserPreviews(page.map(row=>row.legacy_conversation_id));
    const items:ConversationListItem[]=page.map(row=>({...record(row),firstUserMessagePreview:previews.get(row.legacy_conversation_id)??null})),last=items.at(-1);
    return {items,nextCursor:rows.length>limit&&last?encode(sort==="activity"
      ?{v:1,scope,activity:last.lastMessageAt??last.createdAt,id:last.id,fingerprint}
      :{v:1,scope,created:last.createdAt,id:last.id}):null};
  }
  function patch(id:string,change:ConversationPatch) {
    if(!change||!Number.isSafeInteger(change.revision)||change.revision<1)invalid("revision must be a positive integer");
    const allowed=new Set(["revision","title","projectId","archived","trashed","pinned"]);
    if(Object.keys(change).some(k=>!allowed.has(k)))invalid("unknown conversation field");
    if(change.title!==undefined&&(typeof change.title!=="string"||!change.title.trim()||change.title.trim().length>200))invalid("title must contain between 1 and 200 characters");
    if("projectId" in change&&change.projectId!==null&&(typeof change.projectId!=="string"||!change.projectId))invalid("invalid projectId");
    for(const field of ["archived","trashed","pinned"] as const)if(field in change&&typeof change[field]!=="boolean")invalid(`${field} must be boolean`);
    return transaction(db,()=>{
      const current=get(id);
      if(current.revision!==change.revision)throw new ConversationError(409,"conflict","conversation was modified",current);
      if(change.projectId!=null&&!db.prepare("SELECT 1 FROM projects WHERE id=?").get(change.projectId))invalid("project not found");
      const sets:string[]=[],values:SQLInputValue[]=[],now=Date.now();
      if(change.title!==undefined){sets.push("title=?","title_origin='user'");values.push(change.title.trim());}
      /*
        **人自己选的归属要盖章**，和标题那一格同一套（`title_origin='user'`）。
        少了这一下，下一次观测就会按运行记录把它重算掉——人把一条对话挪进某个分组，
        过一会儿自己跑回去了，而且不报错。设成「无分组」也算人的选择，同样盖章。
      */
      if("projectId" in change){sets.push("project_id=?","project_origin='user'");values.push(change.projectId!);}
      for(const field of ["archived","trashed","pinned"] as const)if(change[field]!==undefined){sets.push(`${field}_at=?`);values.push(change[field]?(current[`${field}At`]??now):null);}
      if(!sets.length)return current;
      db.prepare(`UPDATE conversation_catalog SET ${sets.join(",")},revision=revision+1,updated_at=MAX(updated_at,?) WHERE id=? AND revision=?`).run(...values,now,id,change.revision);
      return get(id);
    });
  }
  function historyMeta(id:string) {
    const r=row(id),native=db.prepare("SELECT last_seq,epoch FROM ai_conversations WHERE id=?").get(r.legacy_conversation_id) as {last_seq:number;epoch:number};
    return {cid:r.legacy_conversation_id,upper:native.last_seq,epoch:native.epoch};
  }
  function pageMessages(id:string,opts:{cursor?:string;limit?:number}={}):HistoryPage {
    return atomic(db,()=>{
      const limit=limitOf(opts.limit),meta=historyMeta(id);let upper=meta.upper,before=upper+1;
      if(opts.cursor!==undefined) {
        const c=decode(opts.cursor);
        if(c.v!==1||c.id!==id||c.cid!==meta.cid||![c.before,c.upper,c.epoch].every(Number.isSafeInteger))invalid("cursor does not match history");
        before=c.before as number;upper=c.upper as number;
        if(before<1||upper<0||before>upper+1||upper>meta.upper)invalid("cursor does not match history");
        if(c.epoch!==meta.epoch)throw new ConversationError(409,"history_cursor_expired","history was revised; restart pagination");
      }
      const rows=db.prepare("SELECT * FROM ai_history_messages WHERE conversation_id=? AND seq<? AND seq<=? ORDER BY seq DESC LIMIT ?").all(meta.cid,before,upper,limit+1) as MessageRow[];
      const items:HistoryMessage[]=[];let bytes=2048;
      for(const r of rows.slice(0,limit)){const value=historyMessage(r),size=Buffer.byteLength(JSON.stringify(value));if(bytes+size>512*1024)break;items.push(value);bytes+=size;}
      const last=items.at(-1)?.historySeq??before;
      const hasMore=last>1&&!!db.prepare("SELECT 1 FROM ai_history_messages WHERE conversation_id=? AND seq<? AND seq<=? LIMIT 1").get(meta.cid,last,upper);
      return {items:items.reverse(),nextCursor:hasMore?encode({v:1,id,cid:meta.cid,before:last,upper,epoch:meta.epoch}):null,hasMore,upperBoundSeq:upper,historyEpoch:meta.epoch,conversationId:id,coverage:coverage(meta.cid)};
    });
  }
  function getMessage(id:string,messageId:string):HistoryMessage {
    const meta=historyMeta(id),r=db.prepare("SELECT * FROM ai_history_messages WHERE conversation_id=? AND message_id=?").get(meta.cid,messageId) as MessageRow|undefined;
    if(!r)throw new ConversationError(404,"not_found","history message not found");
    const body=db.prepare("SELECT event_json FROM ai_history_bodies WHERE conversation_id=? AND message_id=?").get(meta.cid,messageId) as {event_json:string}|undefined;
    const result=historyMessage(r,body?.event_json);if(!body&&r.body_state!=="source_backed")result.bodyState="unavailable";return result;
  }
  function ungroupProject(id:string) {
    db.prepare("UPDATE conversation_catalog SET project_id=NULL,revision=revision+1,updated_at=MAX(updated_at,?) WHERE project_id=?").run(Date.now(),id);
  }
  return {list,get,findBySource,patch,pageMessages,getMessage,ungroupProject,...createConversationLinks(db)};
}
export type ConversationsStore = ReturnType<typeof createConversations>;
