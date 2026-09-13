import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AiCommand } from "@roost/terminal-protocol";
import { transaction } from "./database.ts";
import { peerSchema } from "./peer-schema.ts";
import { MAX_PEER_TEXT_BYTES, PeerMessageError, type PeerActor, type PeerDelivery, type PeerDeliveryState, type PeerMessage, type PeerMessageDetail, type PeerPage, type PeerSendInput } from "./peer-types.ts";

type MessageRow = {id:string;sender_kind:"user"|"agent";sender_conversation_id:string|null;sender_run_id:string|null;sender_scope:string;request_id:string;payload_hash:string;recipient_id:string;body:string;format:"text/v1";created_at:number;in_reply_to:string|null};
type DeliveryRow = {id:string;message_id:string;recipient_id:string;enqueue_seq:number;state:PeerDeliveryState;reason:string|null;revision:number;created_at:number;updated_at:number;target_run_id:string|null;target_source_id:string|null;target_owner_epoch:number|null;command_session_id:string|null;command_request_id:string;terminal_instance_id:string|null;generation:string|null;native_session_id:string|null;command_digest:string|null;accepted_native_message_id:string|null;accepted_at:number|null};
type RunRow = {id:string;conversation_id:string;source_id:string;web_session_id:string;terminal_instance_id:string;generation:string;native_session_id:string;cli_id:string;daemon_instance_id:string;owner_epoch:number;state:string};
export type PeerRunClaim = {id:string;conversationId:string;sourceId:string;webSessionId:string;terminalInstanceId:string;generation:string;nativeSessionId:string;cliId:string;daemonInstanceId:string;ownerEpoch:number;state:string};
const hash=(input:string)=>createHash("sha256").update(input).digest("hex");
function fail(status:number,code:string,message?:string):never {throw new PeerMessageError(status,code,message);}
function id(value:unknown,name:string) {if(typeof value!=="string"||!value.trim()||value.length>512||/[\x00-\x1f\x7f]/.test(value))fail(400,"invalid_request",`invalid ${name}`);return value;}
function textOf(value:unknown,maxBytes=MAX_PEER_TEXT_BYTES) {
  if(typeof value!=="string"||!value.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)||/[\uD800-\uDFFF]/u.test(value))fail(400,"invalid_request","invalid text");
  const normalized=value.replace(/\r\n?/g,"\n");
  if(Buffer.byteLength(normalized)>maxBytes)fail(413,"too_large",`text exceeds ${maxBytes} bytes`);return normalized;
}
const message=(r:MessageRow):PeerMessage=>({id:r.id,senderKind:r.sender_kind,senderConversationId:r.sender_conversation_id,senderRunId:r.sender_run_id,senderScope:r.sender_scope,requestId:r.request_id,recipientId:r.recipient_id,text:r.body,format:r.format,createdAt:r.created_at,inReplyTo:r.in_reply_to});
const delivery=(r:DeliveryRow):PeerDelivery=>({id:r.id,messageId:r.message_id,recipientId:r.recipient_id,enqueueSeq:r.enqueue_seq,state:r.state,reason:r.reason,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at,targetRunId:r.target_run_id,targetSourceId:r.target_source_id,targetOwnerEpoch:r.target_owner_epoch,commandSessionId:r.command_session_id,commandRequestId:r.command_request_id,terminalInstanceId:r.terminal_instance_id,generation:r.generation,nativeSessionId:r.native_session_id,commandDigest:r.command_digest,acceptedNativeMessageId:r.accepted_native_message_id,acceptedAt:r.accepted_at});

export function createPeerMessages(db:DatabaseSync) {
  peerSchema(db);
  function catalog(conversationId:string) {
    const row=db.prepare("SELECT id,trashed_at FROM conversation_catalog WHERE id=?").get(conversationId) as {id:string;trashed_at:number|null}|undefined;
    if(!row)fail(404,"not_found","conversation not found");return row;
  }
  function messageRow(messageId:string) {
    const row=db.prepare("SELECT * FROM peer_messages WHERE id=?").get(messageId) as MessageRow|undefined;
    if(!row)fail(404,"not_found","message not found");return row;
  }
  function deliveryRow(deliveryId:string) {
    const row=db.prepare("SELECT * FROM peer_deliveries WHERE id=?").get(deliveryId) as DeliveryRow|undefined;
    if(!row)fail(404,"not_found","delivery not found");return row;
  }
  function get(messageId:string):PeerMessageDetail {
    const m=messageRow(messageId),d=db.prepare("SELECT * FROM peer_deliveries WHERE message_id=?").get(messageId) as DeliveryRow;
    return {message:message(m),delivery:delivery(d)};
  }
  function getDelivery(deliveryId:string) {return delivery(deliveryRow(deliveryId));}
  function activeRun(runId:string,conversationId:string) {
    const r=db.prepare("SELECT * FROM conversation_runs WHERE id=? AND conversation_id=? AND state='active'").get(runId,conversationId) as RunRow|undefined;
    if(!r)fail(409,"run_unavailable","run is not active");
    const source=db.prepare("SELECT id FROM conversation_sources WHERE id=? AND conversation_id=? AND cli_id=? AND native_session_id=?").get(r.source_id,conversationId,r.cli_id,r.native_session_id);
    const binding=db.prepare("SELECT record_json FROM ai_session_records WHERE session_id=?").get(r.web_session_id) as {record_json:string}|undefined;
    const b=binding?JSON.parse(binding.record_json).binding:undefined;
    const terminal=db.prepare("SELECT 1 FROM sessions WHERE id=? AND closed=0").get(r.web_session_id);
    if(!source||!terminal||!b||b.webSessionId!==r.web_session_id||b.terminalInstanceId!==r.terminal_instance_id||b.generation!==r.generation||b.nativeSessionId!==r.native_session_id||b.cliId!==r.cli_id)fail(409,"run_unavailable","run binding no longer matches");
    return r;
  }
  function authenticate(actor:PeerActor) {
    if(!actor||!(actor.kind==="user"||actor.kind==="agent"))fail(403,"forbidden","invalid sender");
    if(actor.kind==="user")return {scope:"user:local",conversationId:null,runId:null};
    id(actor.conversationId,"sender conversation");id(actor.runId,"sender run");
    if(catalog(actor.conversationId).trashed_at!==null)fail(409,"conversation_trashed");
    activeRun(actor.runId,actor.conversationId);
    return {scope:`agent:${actor.conversationId}`,conversationId:actor.conversationId,runId:actor.runId};
  }
  function send(actor:PeerActor,input:PeerSendInput):PeerMessageDetail {
    const recipientId=id(input?.recipientId,"recipientId"),requestId=id(input?.requestId,"requestId"),body=textOf(input?.text);
    const reply=input.inReplyTo==null?null:id(input.inReplyTo,"inReplyTo");
    const digest=hash(JSON.stringify({recipientId,text:body,inReplyTo:reply}));
    return transaction(db,()=>{
      // Authorization is checked even for a duplicate key; a revoked run cannot
      // regain access simply by replaying an earlier request.
      const sender=authenticate(actor);
      const old=db.prepare("SELECT id,payload_hash FROM peer_messages WHERE sender_scope=? AND request_id=?").get(sender.scope,requestId) as {id:string;payload_hash:string}|undefined;
      if(old){if(old.payload_hash!==digest)fail(409,"request_conflict");return get(old.id);}
      if(catalog(recipientId).trashed_at!==null)fail(409,"conversation_trashed");
      if(sender.conversationId===recipientId)fail(400,"self_send_forbidden");
      if(reply) {
        const original=messageRow(reply);
        if(actor.kind!=="agent"||original.recipient_id!==actor.conversationId||original.sender_conversation_id!==recipientId)fail(400,"invalid_reply","reply must return to the original agent sender");
      }
      const count=db.prepare("SELECT COUNT(*) AS n FROM peer_deliveries WHERE recipient_id=? AND state IN ('queued','dispatching','uncertain')").get(recipientId) as {n:number};
      if(count.n>=20)fail(429,"queue_full");
      const messageId=randomUUID(),deliveryId=randomUUID(),now=Date.now();
      db.prepare(`INSERT INTO peer_messages(id,sender_kind,sender_conversation_id,sender_run_id,sender_scope,request_id,payload_hash,recipient_id,body,format,created_at,in_reply_to)
        VALUES(?,?,?,?,?,?,?,?,?,'text/v1',?,?)`).run(messageId,actor.kind,sender.conversationId,sender.runId,sender.scope,requestId,digest,recipientId,body,now,reply);
      db.prepare(`INSERT INTO peer_deliveries(id,message_id,recipient_id,state,reason,created_at,updated_at,command_request_id)
        VALUES(?,?,?,'queued','pending',?,?,?)`).run(deliveryId,messageId,recipientId,now,now,`peer:${deliveryId}`);
      return get(messageId);
    });
  }
  function page(conversationId:string,direction:"inbox"|"outbox",opts:{cursor?:string;limit?:number}={}):PeerPage {
    catalog(conversationId);const limit=opts.limit??50;
    if(!Number.isInteger(limit)||limit<1||limit>100)fail(400,"invalid_request","limit must be between 1 and 100");
    let before=Number.MAX_SAFE_INTEGER;
    if(opts.cursor!==undefined) {
      if(typeof opts.cursor!=="string"||opts.cursor.length>2048)fail(400,"invalid_request","invalid cursor");
      let c:any;try{c=JSON.parse(Buffer.from(opts.cursor,"base64url").toString("utf8"));}catch{fail(400,"invalid_request","invalid cursor");}
      if(!c||c.v!==1||c.id!==conversationId||c.direction!==direction||!Number.isSafeInteger(c.before)||c.before<1)fail(400,"invalid_request","cursor does not match mailbox");before=c.before;
    }
    const rows=db.prepare(`SELECT d.* FROM peer_deliveries d JOIN peer_messages m ON m.id=d.message_id
      WHERE ${direction==="inbox"?"d.recipient_id":"m.sender_conversation_id"}=? AND d.enqueue_seq<? ORDER BY d.enqueue_seq DESC LIMIT ?`).all(conversationId,before,limit+1) as DeliveryRow[];
    const items=rows.slice(0,limit).map(r=>{const {text,...m}=message(messageRow(r.message_id));return {message:{...m,preview:text.slice(0,512),truncated:text.length>512},delivery:delivery(r)};});
    return {items,nextCursor:rows.length>limit?Buffer.from(JSON.stringify({v:1,id:conversationId,direction,before:items.at(-1)!.delivery.enqueueSeq})).toString("base64url"):null};
  }
  function cancel(deliveryId:string) {
    return transaction(db,()=>{
      const d=deliveryRow(deliveryId);if(d.state==="cancelled")return delivery(d);
      if(d.state!=="queued")fail(409,"already_dispatching","only queued messages can be cancelled");
      db.prepare("UPDATE peer_deliveries SET state='cancelled',reason='user_cancelled',revision=revision+1,updated_at=? WHERE id=? AND state='queued'").run(Date.now(),deliveryId);
      return getDelivery(deliveryId);
    });
  }
  function queued(recipientId?:string) {
    return (db.prepare(`SELECT * FROM peer_deliveries WHERE state='queued'${recipientId===undefined?"":" AND recipient_id=?"} ORDER BY enqueue_seq LIMIT 100`).all(...(recipientId===undefined?[]:[recipientId])) as DeliveryRow[]).map(delivery);
  }
  function pending(opts:{afterSeq?:number;limit?:number}={}) {
    const after=opts.afterSeq??0,limit=opts.limit??100;
    if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)fail(400,"invalid_request","invalid pending page");
    return (db.prepare("SELECT * FROM peer_deliveries WHERE state IN ('dispatching','uncertain') AND enqueue_seq>? ORDER BY enqueue_seq LIMIT ?").all(after,limit) as DeliveryRow[]).map(delivery);
  }
  function getByCommand(webSessionId:string,requestId:string) {
    const row=db.prepare("SELECT * FROM peer_deliveries WHERE command_session_id=? AND command_request_id=?").get(webSessionId,requestId) as DeliveryRow|undefined;
    return row?delivery(row):undefined;
  }
  function claimDelivery(deliveryId:string,claim:PeerRunClaim,commandText?:string) {
    return transaction(db,()=>{
      const d=deliveryRow(deliveryId);
      if(d.state!=="queued")fail(409,"already_dispatching");
      if(catalog(d.recipient_id).trashed_at!==null)fail(409,"conversation_trashed");
      const r=activeRun(claim.id,d.recipient_id);
      const actual={id:r.id,conversationId:r.conversation_id,sourceId:r.source_id,webSessionId:r.web_session_id,terminalInstanceId:r.terminal_instance_id,generation:r.generation,nativeSessionId:r.native_session_id,cliId:r.cli_id,daemonInstanceId:r.daemon_instance_id,ownerEpoch:r.owner_epoch,state:r.state};
      if(Object.entries(actual).some(([key,value])=>claim[key as keyof PeerRunClaim]!==value))fail(409,"run_unavailable","run claim changed");
      const blocker=db.prepare("SELECT id FROM peer_deliveries WHERE recipient_id=? AND (state IN ('dispatching','uncertain') OR (state='queued' AND enqueue_seq<?)) LIMIT 1").get(d.recipient_id,d.enqueue_seq);
      if(blocker)fail(409,"recipient_blocked","recipient has an earlier or unresolved delivery");
      const body=textOf(commandText??messageRow(d.message_id).body,16*1024);
      db.prepare(`UPDATE peer_deliveries SET state='dispatching',reason=NULL,revision=revision+1,updated_at=?,target_run_id=?,target_source_id=?,target_owner_epoch=?,command_session_id=?,terminal_instance_id=?,generation=?,native_session_id=?,command_digest=?
        WHERE id=? AND state='queued'`).run(Date.now(),r.id,r.source_id,r.owner_epoch,r.web_session_id,r.terminal_instance_id,r.generation,r.native_session_id,hash(body),deliveryId);
      return getDelivery(deliveryId);
    });
  }
  function finishFromCommand(deliveryId:string,command:AiCommand) {
    return transaction(db,()=>{
      const d=deliveryRow(deliveryId);
      const r=d.target_run_id?db.prepare("SELECT * FROM conversation_runs WHERE id=?").get(d.target_run_id) as RunRow|undefined:undefined;
      const source=d.target_source_id?db.prepare("SELECT id FROM conversation_sources WHERE id=? AND conversation_id=? AND native_session_id=? AND cli_id=?").get(d.target_source_id,d.recipient_id,d.native_session_id,r?.cli_id??""):undefined;
      if(!r||!source||r.conversation_id!==d.recipient_id||r.source_id!==d.target_source_id||r.owner_epoch!==d.target_owner_epoch||r.web_session_id!==d.command_session_id||r.terminal_instance_id!==d.terminal_instance_id||r.generation!==d.generation||r.native_session_id!==d.native_session_id||command.type!=="submit"||command.webSessionId!==d.command_session_id||command.requestId!==d.command_request_id||command.terminalInstanceId!==d.terminal_instance_id||command.generation!==d.generation||command.nativeSessionId!==d.native_session_id||typeof command.text!=="string"||hash(command.text.replace(/\r\n?/g,"\n"))!==d.command_digest)fail(409,"command_mismatch","command does not match claimed delivery");
      if(!["dispatching","uncertain"].includes(d.state))return delivery(d);
      let state:PeerDeliveryState,reason=command.reason;
      if(command.status==="accepted") {
        if(typeof command.nativeMessageId!=="string"||!command.nativeMessageId.trim()||!Number.isSafeInteger(command.writtenAt)||command.writtenAt!<0)fail(409,"receipt_missing","accepted command lacks native receipt");
        const used=db.prepare("SELECT id FROM peer_deliveries WHERE target_source_id=? AND accepted_native_message_id=? AND id<>?").get(d.target_source_id,command.nativeMessageId,d.id);
        if(used)fail(409,"receipt_conflict");state="accepted";
      } else if(command.status==="uncertain")state="uncertain";
      else if(command.status==="failed"||command.status==="cancelled")state=command.writtenAt===null?(command.status==="failed"?"failed":"cancelled"):"uncertain";
      else return delivery(d);
      if(d.state===state&&d.reason===reason)return delivery(d);
      db.prepare(`UPDATE peer_deliveries SET state=?,reason=?,revision=revision+1,updated_at=?,accepted_native_message_id=?,accepted_at=? WHERE id=?`)
        .run(state,reason,Date.now(),state==="accepted"?command.nativeMessageId:null,state==="accepted"?Date.now():null,d.id);
      return getDelivery(d.id);
    });
  }
  function markUncertain(deliveryId:string,reason="submission_uncertain") {
    return transaction(db,()=>{
      const d=deliveryRow(deliveryId);if(d.state!=="dispatching")return delivery(d);
      db.prepare("UPDATE peer_deliveries SET state='uncertain',reason=?,revision=revision+1,updated_at=? WHERE id=? AND state='dispatching'").run(reason.slice(0,200),Date.now(),deliveryId);return getDelivery(deliveryId);
    });
  }
  function setQueuedReason(deliveryId:string,reason:string) {
    return transaction(db,()=>{
      const d=deliveryRow(deliveryId);if(d.state!=="queued"||d.reason===reason)return delivery(d);
      db.prepare("UPDATE peer_deliveries SET reason=?,revision=revision+1,updated_at=? WHERE id=? AND state='queued'").run(reason.slice(0,200),Date.now(),deliveryId);return getDelivery(deliveryId);
    });
  }
  function onConversationTrashed(conversationId:string) {
    return transaction(db,()=>Number(db.prepare(`UPDATE peer_deliveries SET reason='conversation_trashed',revision=revision+1,updated_at=?
      WHERE recipient_id=? AND state='queued' AND reason IS NOT 'conversation_trashed'`).run(Date.now(),conversationId).changes));
  }
  return {send,get,getDelivery,getByCommand,cancel,queued,pending,claimDelivery,finishFromCommand,markUncertain,setQueuedReason,onConversationTrashed,
    inbox:(id:string,opts?:{cursor?:string;limit?:number})=>page(id,"inbox",opts),outbox:(id:string,opts?:{cursor?:string;limit?:number})=>page(id,"outbox",opts)};
}
export type PeerMessagesStore=ReturnType<typeof createPeerMessages>;
