import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';
import { createNotes } from './notes.ts';
import { createSnippets } from './snippets.ts';
import { LibraryError, type LibraryFields } from './library-types.ts';
export type LibraryImportItem = LibraryFields & {id:string;createdAt?:unknown;updatedAt?:unknown};
export type LibraryImport = {sourceId:string;batchId:string;notes:LibraryImportItem[];snippets:LibraryImportItem[]};
// Canonical object key ordering makes retries independent of JSON key serialization order.
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
export function createLibrary(db:DatabaseSync) {
  const notes=createNotes(db),snippets=createSnippets(db);
  const info=()=>({libraryId:(db.prepare("SELECT value FROM meta WHERE key='libraryId'").get() as {value:string}).value});
  return {notes,snippets,info,
    importBatch(batch:LibraryImport) {
      const hash=createHash('sha256').update(canonical(batch)).digest('hex');
      return transaction(db,()=>{
        const previous=db.prepare('SELECT content_hash,result_json FROM library_imports WHERE source_id=? AND batch_id=?').get(batch.sourceId,batch.batchId) as {content_hash:string;result_json:string}|undefined;
        if(previous){if(previous.content_hash!==hash)throw new LibraryError(409,'batch_conflict','batchId was already used with different content');return JSON.parse(previous.result_json)}
        const now=Date.now();
        const time=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=8_640_000_000_000_000?value:now;
        const result={...info(),sourceId:batch.sourceId,batchId:batch.batchId,
          notes:batch.notes.map(item=>notes.importRecord(item.id,item,time(item.createdAt),time(item.updatedAt))),
          snippets:batch.snippets.map(item=>snippets.importRecord(item.id,item,time(item.createdAt),time(item.updatedAt))),
        };
        db.prepare('INSERT INTO library_imports(source_id,batch_id,content_hash,result_json,created_at) VALUES (?,?,?,?,?)').run(batch.sourceId,batch.batchId,hash,JSON.stringify(result),now);
        return result;
      });
    },
  };
}
