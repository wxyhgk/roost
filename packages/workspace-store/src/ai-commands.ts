import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {AiCommandError,validateAiCommandInput,MAX_AI_QUEUED_COMMANDS,type AiCommand,type AiCommandInput,type AiCommandState} from '@roost/terminal-protocol';
import {transaction} from './database.ts';

export function createAiCommands(db:DatabaseSync) {
 db.exec(`CREATE TABLE IF NOT EXISTS ai_commands(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(session_id,request_id));
 CREATE INDEX IF NOT EXISTS ai_commands_session ON ai_commands(session_id,seq);
 CREATE INDEX IF NOT EXISTS ai_commands_state ON ai_commands(json_extract(record_json,'$.status'));
 CREATE UNIQUE INDEX IF NOT EXISTS ai_commands_native_receipt ON ai_commands(json_extract(record_json,'$.nativeSessionId'),json_extract(record_json,'$.nativeMessageId')) WHERE json_extract(record_json,'$.status')='accepted' AND json_extract(record_json,'$.nativeMessageId') IS NOT NULL;`);
 // Old daemon/gateway connections must not erase receipts during terminal
 // deletion. The capability is registered by upgraded AI storage connections.
 if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_catalog'").get()) {
  db.exec(`CREATE TRIGGER IF NOT EXISTS conversation_command_delete_guard
    BEFORE DELETE ON ai_commands BEGIN
      SELECT CASE WHEN diy_conversation_writer_v1() IS NOT 1
        THEN RAISE(ABORT,'conversation storage requires upgraded writer') END;
    END;`);
 }
 const decode=(row:any):AiCommand|undefined=>row?{...JSON.parse(row.record_json),seq:Number(row.seq)}:undefined;
 const get=(id:string,requestId:string)=>decode(db.prepare('SELECT seq,record_json FROM ai_commands WHERE session_id=? AND request_id=?').get(id,requestId));
 const active=(id?:string):AiCommand[]=>db.prepare(`SELECT seq,record_json FROM ai_commands WHERE json_extract(record_json,'$.status') IN ('queued','writing','awaiting_acceptance','uncertain')${id===undefined?'':' AND session_id=?'} ORDER BY seq`).all(...(id===undefined?[]:[id])).map(row=>decode(row)!);
 function update(id:string,requestId:string,expected:AiCommandState[],patch:Partial<AiCommand>) {
  return transaction(db,()=>{
   const old=get(id,requestId);if(!old||!expected.includes(old.status))return old;
   const next={...old,...patch,webSessionId:id,requestId,seq:old.seq,revision:old.revision+1,updatedAt:Date.now()};
   db.prepare('UPDATE ai_commands SET record_json=? WHERE session_id=? AND request_id=?').run(JSON.stringify(next),id,requestId);return next;
  });
 }
 return {
  get,active,update,
  hasAcceptedMessage(nativeId:string,messageId:string){return !!db.prepare("SELECT 1 FROM ai_commands WHERE json_extract(record_json,'$.status')='accepted' AND json_extract(record_json,'$.nativeSessionId')=? AND json_extract(record_json,'$.nativeMessageId')=?").get(nativeId,messageId);},
  enqueue(id:string,input:AiCommandInput) {
   validateAiCommandInput(input);
   const canonical={requestId:input.requestId,type:'submit' as const,terminalInstanceId:input.terminalInstanceId,generation:input.generation,nativeSessionId:input.nativeSessionId,text:input.text.replace(/\r\n?/g,'\n')};
   const digest=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
   return transaction(db,()=>{
    const old=db.prepare('SELECT * FROM ai_commands WHERE session_id=? AND request_id=?').get(id,input.requestId);
    if(old){if(old.digest!==digest)throw new AiCommandError(409,'request_conflict');return decode(old)!;}
    if(!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id))throw new AiCommandError(404,'not_found');
    if(active(id).filter(c=>c.status==='queued').length>=MAX_AI_QUEUED_COMMANDS)throw new AiCommandError(429,'queue_full');
    const now=Date.now();const record={...canonical,webSessionId:id,seq:0,revision:1,status:'queued' as const,reason:null,createdAt:now,updatedAt:now,writtenAt:null,inputEpoch:null,sourceSeq:null,hookSeq:null,nativeMessageId:null,transcriptOffset:null};
    const result=db.prepare('INSERT INTO ai_commands(session_id,request_id,digest,record_json) VALUES(?,?,?,?)').run(id,input.requestId,digest,JSON.stringify(record));return {...record,seq:Number(result.lastInsertRowid)};
   });
  },
  list(id:string,before?:number,limit=50) {
   if((before!==undefined&&(!Number.isSafeInteger(before)||before<1))||!Number.isInteger(limit)||limit<1||limit>100)throw new AiCommandError(400,'invalid_request');
   const rows=db.prepare(`SELECT seq,record_json FROM ai_commands WHERE session_id=?${before===undefined?'':' AND seq<?'} ORDER BY seq DESC LIMIT ?`).all(id,...(before===undefined?[]:[before]),limit+1);
   const items=rows.slice(0,limit).map(r=>decode(r)!);return {items,nextCursor:rows.length>limit?items.at(-1)!.seq:null};
  },
  cancel(id:string,requestId:string) {
   const old=get(id,requestId);if(!old)throw new AiCommandError(404,'not_found');
   if(old.status==='cancelled')return old;
   if(old.status!=='queued')throw new AiCommandError(409,'already_writing');
   const result=update(id,requestId,['queued'],{status:'cancelled',reason:'user_cancelled'})!;
   if(result.status!=='cancelled')throw new AiCommandError(409,'already_writing');return result;
  },
  recoverOwner() {for(const c of active())update(c.webSessionId,c.requestId,[c.status],{status:c.status==='queued'?'cancelled':'uncertain',reason:'daemon_restarted'});},
  invalidate(id:string,reason:string) {for(const c of active(id))update(id,c.requestId,[c.status],{status:c.status==='queued'?'cancelled':'uncertain',reason});},
  remove(id:string){db.prepare('DELETE FROM ai_commands WHERE session_id=?').run(id);},
 };
}
