import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { assertInside, MAX_RAW_BYTES } from "./fs";
import { sendError, type ApiErrorCode } from "./http";

export const MAX_UPLOAD_BYTES = MAX_RAW_BYTES;
export type UploadConflict = "error" | "rename" | "overwrite";
export class FileUploadError extends Error {
  constructor(public status: number, public code: ApiErrorCode, message: string) { super(message); }
}
const fail = (status: number, code: ApiErrorCode, message: string): never => { throw new FileUploadError(status, code, message); };
async function inspect(path: string) {
  try { return await lstat(path); }
  catch(error) { if((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
const sameFile = (a: Awaited<ReturnType<typeof inspect>>, b: Awaited<ReturnType<typeof inspect>>) =>
  a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Stage in the destination filesystem, never buffer the whole body or expose a partial target. */
export async function uploadFile(root: string, path: string, source: AsyncIterable<Uint8Array>,
  conflict: UploadConflict = "error", signal?: AbortSignal) {
  if(!root || !path || root.includes("\0") || path.includes("\0")) fail(400,"invalid_request","root and file path required");
  const requested = resolve(root,path);
  assertInside(root,requested);
  const canonicalRoot = await realpath(root), parent = await realpath(dirname(requested));
  assertInside(canonicalRoot,parent);
  if(requested === resolve(root)) fail(400,"not_file","workspace root is not an upload destination");
  const file = resolve(parent,basename(requested)), original = await inspect(file);
  if(conflict === "error" && original) fail(409,"conflict","file already exists");
  if(conflict === "overwrite" && original && !original.isFile()) fail(400,"not_file","only regular files can be replaced");
  const temporary = resolve(parent,`.diy-upload-${randomUUID()}.tmp`);
  let created = false;
  try {
    signal?.throwIfAborted();
    const handle = await open(temporary,"wx",0o600); created = true;
    let size = 0, mtime: number;
    try {
      for await(const chunk of source) {
        signal?.throwIfAborted();
        size += chunk.byteLength;
        if(size > MAX_UPLOAD_BYTES) fail(413,"too_large","file exceeds 64 MiB upload limit");
        let offset = 0;
        while(offset < chunk.byteLength) {
          const {bytesWritten} = await handle.write(chunk,offset,chunk.byteLength-offset);
          if(!bytesWritten) throw new Error("file write made no progress");
          offset += bytesWritten;
        }
      }
      signal?.throwIfAborted();
      await handle.chmod(conflict === "overwrite" && original ? original.mode & 0o777 : 0o644);
      await handle.sync();
      mtime = (await handle.stat()).mtimeMs;
    } finally { await handle.close(); }
    signal?.throwIfAborted();
    if(await realpath(root) !== canonicalRoot || await realpath(dirname(requested)) !== parent)
      fail(409,"conflict","upload destination changed during transfer");
    if(conflict === "overwrite" && original) {
      if(!sameFile(original,await inspect(file))) fail(409,"conflict","file changed during transfer");
      await rename(temporary,file);
      return {name:basename(file),path:relative(canonicalRoot,file),size,mtime,overwritten:true};
    }
    const extension = extname(file), stem = basename(file,extension);
    for(let index = 0; index < (conflict === "rename" ? 1000 : 1); index++) {
      signal?.throwIfAborted();
      const destination = index === 0 ? file : resolve(parent,`${stem}-${index}${extension}`);
      try {
        // link is atomic and fails EEXIST even if another uploader wins after the initial check.
        await link(temporary,destination);
        return {name:basename(destination),path:relative(canonicalRoot,destination),size,mtime,overwritten:false};
      } catch(error) {
        if((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if(conflict !== "rename") fail(409,"conflict","file already exists");
      }
    }
    return fail(409,"conflict","automatic filename candidates exhausted");
  } finally { if(created) await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw error;}); }
}

/** Limit concurrent disk writers; each reader naturally backpressures the HTTP body. */
export function createFileUploadHandler() {
  let active = 0;
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if(url.pathname !== "/api/fs/file") return false;
    let acquired = false;
    const controller = new AbortController();
    const aborted = () => controller.abort();
    const disconnected = () => { if(!res.writableFinished) aborted(); };
    req.once("aborted",aborted);
    res.once("close",disconnected);
    try {
      if(req.method !== "POST") { res.setHeader("allow","POST"); fail(405,"method_not_allowed","POST required"); }
      for(const key of url.searchParams.keys())
        if(!["root","path","conflict"].includes(key) || url.searchParams.getAll(key).length!==1) fail(400,"invalid_request","invalid query parameter");
      const root = url.searchParams.get("root"), path = url.searchParams.get("path");
      if(!root || !path) fail(400,"invalid_request","root and path required");
      const conflict = url.searchParams.get("conflict") ?? "error";
      if(!["error","rename","overwrite"].includes(conflict)) fail(400,"invalid_request","invalid conflict policy");
      const encoding = req.headers["content-encoding"];
      if(encoding && encoding !== "identity") fail(415,"unsupported_media_type","encoded upload bodies are unsupported");
      if(Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) fail(413,"too_large","file exceeds 64 MiB upload limit");
      if(active >= 4) fail(429,"upload_busy","too many concurrent uploads");
      active++; acquired = true;
      // Returning early from an oversized request must not destroy its socket before the JSON 413.
      const result = await uploadFile(root!,path!,req.iterator({destroyOnReturn:false}),conflict as UploadConflict,controller.signal);
      if(!res.destroyed) {res.writeHead(201,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(result));}
    } catch(error) {
      if(res.destroyed || req.aborted) return true;
      let status = 500, code: ApiErrorCode = "internal_error", message = "file upload failed";
      if(error instanceof FileUploadError) ({status,code,message}=error);
      else if(error instanceof Error && error.message === "path escapes workspace") {status=403;code="path_escape";message=error.message;}
      else {
        const fsCode = (error as NodeJS.ErrnoException).code;
        if(fsCode === "ENOENT") {status=404;code="not_found";message="upload directory not found";}
        else if(fsCode === "EACCES" || fsCode === "EPERM") {status=403;code="permission_denied";message="upload destination is not writable";}
        else if(fsCode === "ENOTDIR" || fsCode === "EISDIR") {status=400;code="not_file";message="invalid upload destination";}
        else if(fsCode === "ENOSPC" || fsCode === "EDQUOT") {status=507;code="storage_unavailable";message="insufficient storage for upload";}
      }
      if(!req.complete) {req.pause();res.setHeader("connection","close");}
      sendError(res,status,code,message);
    } finally {req.off("aborted",aborted);res.off("close",disconnected);if(acquired)active--;}
    return true;
  };
}
