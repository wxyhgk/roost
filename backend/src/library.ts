import type { IncomingMessage, ServerResponse } from 'node:http';
import { LibraryError, type WorkspaceStore, type LibraryKind, type LibraryFields, type LibraryImport, type LibraryImportItem } from '@roost/workspace-store';
import { HttpInputError, readJson } from './http';
const BODY_BYTES=1024*1024;
const RECORD_REQUEST_BYTES=6*BODY_BYTES+64*1024;
const IMPORT_REQUEST_BYTES=8*BODY_BYTES;
const legacyId=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalid=(message:string):never=>{throw new LibraryError(400,'invalid_request',message)};
function object(value:unknown,location:string):Record<string,unknown> {
  if(value===null||typeof value!=='object'||Array.isArray(value))return invalid(`${location}: object required`);
  return value as Record<string,unknown>;
}
function keys(value:Record<string,unknown>,allowed:string[],location:string) {
  for(const key of Object.keys(value))if(!allowed.includes(key))invalid(`${location}.${key}: unknown field`);
}
function id(value:unknown,location:string,legacy=true):string {
  if(typeof value!=='string'||!(legacy?legacyId:uuid).test(value))return invalid(`${location}: ${legacy?'valid ID':'UUID'} required`);
  return value;
}
function revision(value:unknown):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>=Number.MAX_SAFE_INTEGER)return invalid('revision: positive safe integer required');
  return value;
}
function fields(value:Record<string,unknown>,kind:LibraryKind,location:string,partial:boolean):LibraryFields {
  const names=kind==='notes'?['text']:['title','lang','code'];
  const result:LibraryFields={};
  for(const name of names) {
    if(!Object.hasOwn(value,name)){
      if(!partial&&name!=='lang')invalid(`${location}.${name}: string required`);
      continue;
    }
    const text=value[name];if(typeof text!=='string')return invalid(`${location}.${name}: string required`);
    const limit=name==='title'?256:name==='lang'?64:null;
    if(limit!==null?Array.from(text).length>limit:Buffer.byteLength(text)>BODY_BYTES)throw new LibraryError(413,'too_large',`${location}.${name}: exceeds ${limit===null?'1 MiB':limit+' characters'}`);
    if(name==='lang'&&!/^[A-Za-z0-9_+.#-]*$/.test(text))invalid(`${location}.lang: invalid language identifier`);
    result[name as keyof LibraryFields]=text;
  }
  return result;
}
function parseImport(body:Record<string,unknown>):LibraryImport {
  keys(body,['sourceId','batchId','notes','snippets'],'body');
  const sourceId=id(body.sourceId,'sourceId'),batchId=id(body.batchId,'batchId');
  if(!Array.isArray(body.notes)||!Array.isArray(body.snippets))invalid('notes and snippets: arrays required');
  const notes=body.notes as unknown[],snippets=body.snippets as unknown[];
  if(notes.length+snippets.length>100)throw new LibraryError(413,'too_large','batch exceeds 100 records');
  const parse=(entries:unknown[],kind:LibraryKind)=>{
    const seen=new Set<string>();
    return entries.map((value,index):LibraryImportItem=>{
      const location=`${kind}[${index}]`,entry=object(value,location);
      keys(entry,['id','createdAt','updatedAt',...(kind==='notes'?['text']:['title','lang','code'])],location);
      const identifier=id(entry.id,location+'.id');
      if(seen.has(identifier))invalid(`${location}.id: duplicate ID within batch`);seen.add(identifier);
      const content=fields(entry,kind,location,false);
      return {id:identifier,...content,...(Object.hasOwn(entry,'createdAt')?{createdAt:entry.createdAt}:{}),...(Object.hasOwn(entry,'updatedAt')?{updatedAt:entry.updatedAt}:{})};
    });
  };
  return {sourceId,batchId,notes:parse(notes,'notes'),snippets:parse(snippets,'snippets')};
}
function listOptions(params:URLSearchParams,kind:LibraryKind) {
  for(const key of params.keys())if(!['q','limit','cursor'].includes(key)||params.getAll(key).length!==1)invalid('invalid or repeated query parameter');
  const q=params.get('q')??'';
  if(Array.from(q).length>200)throw new LibraryError(413,'too_large','q exceeds 200 characters');
  const size=params.get('limit')??'50';if(!/^[1-9]\d*$/.test(size)||Number(size)>100)invalid('limit must be between 1 and 100');
  let after:{updatedAt:number;id:string}|undefined;
  const cursor=params.get('cursor');
  if(cursor!==null){
    try {
      if(cursor.length>4096||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();
      const data=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
      if(data.v!==1||data.kind!==kind||data.q!==q||!Number.isSafeInteger(data.updatedAt)||data.updatedAt<0||typeof data.id!=='string'||!legacyId.test(data.id))throw new Error();
      after={updatedAt:data.updatedAt,id:data.id};
    }catch{return invalid('invalid cursor or cursor does not match filter')}
  }
  return {q,limit:Number(size),after};
}
function json(res:ServerResponse,status:number,body:unknown) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));
}

/** Returns false for unrelated routes. Every library failure has a structured body. */
export async function handleLibrary(req:IncomingMessage,res:ServerResponse,url:URL,store:WorkspaceStore):Promise<boolean> {
  const match=url.pathname.match(/^\/api\/(notes|snippets)(?:\/([^/]+))?$/);
  if(!match&&!['/api/library/info','/api/library/import'].includes(url.pathname))return false;
  try {
    if(url.pathname==='/api/library/info'&&req.method==='GET'){json(res,200,store.library.info());return true}
    if(url.pathname==='/api/library/import'&&req.method==='POST'){
      const batch=parseImport(await readJson(req,IMPORT_REQUEST_BYTES));
      json(res,200,store.library.importBatch(batch));return true;
    }
    if(!match){json(res,405,{error:{code:'method_not_allowed',message:'method not allowed'}});return true}
    const kind=match[1] as LibraryKind,collection=store.library[kind];
    let identifier:string|undefined;
    if(match[2]){try{identifier=id(decodeURIComponent(match[2]),'id')}catch(error){if(error instanceof LibraryError)throw error;invalid('invalid encoded ID')}}
    if(!identifier&&req.method==='GET') {
      const {q,limit,after}=listOptions(url.searchParams,kind),result=collection.list(q,limit,after);
      json(res,200,{items:result.items,nextCursor:result.next?Buffer.from(JSON.stringify({v:1,kind,q,...result.next})).toString('base64url'):null});return true;
    }
    if(!identifier&&req.method==='POST') {
      const body=await readJson(req,RECORD_REQUEST_BYTES);
      keys(body,['id',...(kind==='notes'?['text']:['title','lang','code'])],'body');
      const result=collection.create(id(body.id,'id',false),fields(body,kind,'body',false));
      json(res,result.created?201:200,result.record);return true;
    }
    if(identifier&&req.method==='GET'){json(res,200,collection.get(identifier));return true}
    if(identifier&&req.method==='PATCH') {
      const body=await readJson(req,RECORD_REQUEST_BYTES);
      keys(body,['revision',...(kind==='notes'?['text']:['title','lang','code'])],'body');
      const changes=fields(body,kind,'body',true);
      if(!Object.keys(changes).length)invalid('at least one content field required');
      json(res,200,collection.update(identifier,revision(body.revision),changes));return true;
    }
    if(identifier&&req.method==='DELETE') {
      const body=await readJson(req,1024);keys(body,['revision'],'body');
      json(res,200,collection.remove(identifier,revision(body.revision)));return true;
    }
    json(res,405,{error:{code:'method_not_allowed',message:'method not allowed'}});
  } catch(error) {
    if(error instanceof LibraryError)json(res,error.status,{error:{code:error.code,message:error.message},...(error.current===undefined?{}:{current:error.current})});
    else if(error instanceof HttpInputError)json(res,error.status,{error:{code:error.status===413?'too_large':'invalid_request',message:error.message}});
    else {
      const sqlite=error as {errcode?:number;code?:string};
      const unavailable=[5,6,8,10,13,14].includes((sqlite.errcode??0)&255);
      if(!unavailable)console.error('library operation failed',error);
      json(res,unavailable?503:500,{error:{code:unavailable?'storage_unavailable':'internal_error',message:unavailable?'library storage temporarily unavailable; retry later':'library operation failed'}});
    }
  }
  return true;
}
