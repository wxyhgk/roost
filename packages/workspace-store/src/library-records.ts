import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { transaction } from './database.ts';
import { LibraryError, type LibraryKind, type LibraryRecord, type LibraryFields, type LibraryListItem, type LibraryPosition } from './library-types.ts';

/** Table and column names come only from these fixed definitions, never from requests. */
export function createLibraryRecords(db:DatabaseSync, kind:LibraryKind) {
  const fields=kind==='notes'?['text']:['title','lang','code'];
  const body=kind==='notes'?'text':'code';
  function getRaw(id:string):LibraryRecord|undefined {
    return db.prepare(`SELECT id,${fields.join(',')},revision,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt FROM ${kind} WHERE id=?`).get(id) as LibraryRecord|undefined;
  }
  function current(id:string) {
    const record=getRaw(id);
    if(!record)throw new LibraryError(404,'not_found','record not found');
    if(record.deletedAt!==null)throw new LibraryError(410,'deleted','record was deleted',record);
    return record;
  }
  const defaults=(input:LibraryFields):Record<string,string>=>kind==='notes'?{text:input.text??''}:{title:input.title??'',lang:input.lang??'plaintext',code:input.code??''};
  const same=(record:LibraryRecord,input:LibraryFields)=>{
    const values=defaults(input);
    return fields.every(field=>(record as unknown as Record<string,unknown>)[field]===values[field]);
  };
  function insert(id:string,input:LibraryFields,createdAt:number,updatedAt:number) {
    const values=defaults(input);
    db.prepare(`INSERT INTO ${kind}(id,${fields.join(',')},created_at,updated_at) VALUES (${Array(fields.length+3).fill('?').join(',')})`)
      .run(id,...fields.map(field=>values[field]),createdAt,updatedAt);
    return getRaw(id)!;
  }
  return {
    get:current,
    create(id:string,input:LibraryFields) {
      return transaction(db,()=>{
        const existing=getRaw(id);
        if(existing){
          if(existing.deletedAt!==null)throw new LibraryError(410,'deleted','record was deleted',existing);
          if(same(existing,input))return {created:false,record:existing};
          throw new LibraryError(409,'id_conflict','ID already has different content',existing);
        }
        const now=Date.now();return {created:true,record:insert(id,input,now,now)};
      });
    },
    update(id:string,revision:number,input:LibraryFields) {
      return transaction(db,()=>{
        const changed=fields.filter(field=>Object.hasOwn(input,field));
        const values=changed.map(field=>input[field as keyof LibraryFields]!) as SQLInputValue[];
        const result=db.prepare(`UPDATE ${kind} SET ${changed.map(field=>`${field}=?,`).join('')}revision=revision+1,updated_at=MAX(updated_at,?) WHERE id=? AND revision=? AND deleted_at IS NULL`)
          .run(...values,Date.now(),id,revision);
        if(!result.changes)throw new LibraryError(409,'revision_conflict','record changed since it was read',current(id));
        return getRaw(id)!;
      });
    },
    remove(id:string,revision:number) {
      return transaction(db,()=>{
        const record=getRaw(id);
        if(!record)throw new LibraryError(404,'not_found','record not found');
        if(record.deletedAt===null){
          const result=db.prepare(`UPDATE ${kind} SET revision=revision+1,updated_at=MAX(updated_at,?),deleted_at=? WHERE id=? AND revision=? AND deleted_at IS NULL`).run(Date.now(),Date.now(),id,revision);
          if(!result.changes)throw new LibraryError(409,'revision_conflict','record changed since it was read',getRaw(id));
        }
        const deleted=getRaw(id)!;return {id:deleted.id,revision:deleted.revision,deletedAt:deleted.deletedAt!};
      });
    },
    list(q:string,limit:number,after?:LibraryPosition) {
      const values:SQLInputValue[]=[];let where='deleted_at IS NULL';
      if(q){const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';where+=kind==='notes'?" AND lower(text) LIKE lower(?) ESCAPE '\\'":" AND (lower(title) LIKE lower(?) ESCAPE '\\' OR lower(code) LIKE lower(?) ESCAPE '\\')";values.push(pattern);if(kind==='snippets')values.push(pattern)}
      if(after){where+=' AND (updated_at < ? OR (updated_at = ? AND id < ?))';values.push(after.updatedAt,after.updatedAt,after.id)}
      values.push(limit+1);
      const title=kind==='notes'?"substr(ltrim(text, char(9)||char(10)||char(13)||' '),1,1024) AS heading":'title,lang';
      const rows=db.prepare(`SELECT id,revision,created_at AS createdAt,updated_at AS updatedAt,${title},substr(${body},1,160) AS summary FROM ${kind} WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(...values);
      const items=rows.slice(0,limit).map(row=>{
        const {heading,...rest}=row;
        return {...rest,title:kind==='notes'?Array.from(String(heading).split(/[\r\n]/,1)[0].trim()).slice(0,256).join(''):row.title} as LibraryListItem;
      });
      const last=items.at(-1);
      return {items,next:rows.length>limit&&last?{updatedAt:last.updatedAt,id:last.id}:null};
    },
    // The import coordinator owns the transaction shared with its ledger.
    importRecord(id:string,input:LibraryFields,createdAt:number,updatedAt:number) {
      const existing=getRaw(id);
      if(existing)return {id,status:existing.deletedAt!==null?'deleted':same(existing,input)?'existing':'conflict',revision:existing.revision,...(existing.deletedAt!==null?{deletedAt:existing.deletedAt}:{})};
      const record=insert(id,input,createdAt,updatedAt);return {id,status:'created',revision:record.revision};
    },
  };
}
