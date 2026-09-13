import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import sharp from "sharp";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;
const MAX_PIXELS = 25_000_000;

export { AttachmentError } from './errors.ts';
import { AttachmentError } from './errors.ts';
import { createCatalog, sessionKey } from './catalog.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData); req.off("end", onEnd);
      req.off("aborted", onAborted); req.off("error", onError);
      if (error) { req.once("error", () => {}); req.resume(); reject(error); }
      else resolveBody(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) finish(new AttachmentError(413, "attachment request too large"));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAborted = () => finish(new AttachmentError(400, "upload aborted"));
    const onError = () => finish(new AttachmentError(400, "upload failed"));
    const timer = setTimeout(() => finish(new AttachmentError(408, "upload timed out")), 30_000);
    timer.unref();
    req.on("data", onData); req.once("end", onEnd);
    req.once("aborted", onAborted); req.once("error", onError);
  });
}

export function createAttachmentStore({ directory }: { directory: string }) {
  const base = resolve(directory);
  let active = 0;
  const uploading = new Map<string,number>();
  const catalog = createCatalog(base,key=>(uploading.get(key)??0)>0);
  return {
    ...catalog,
    async receive(req: IncomingMessage, sessionId: string, instanceId: string, isCurrent: () => boolean) {
      if (active >= 2) throw new AttachmentError(429, "too many image uploads; retry shortly");
      active++;
      const key=sessionKey(sessionId);
      uploading.set(key,(uploading.get(key)??0)+1);
      try {
        const contentType = req.headers["content-type"] ?? "";
        if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new AttachmentError(415, "multipart/form-data required");
        const length = Number(req.headers["content-length"]);
        if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new AttachmentError(413, "attachment request too large");
        const body = await readBody(req);
        let form: FormData;
        try { form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData(); }
        catch { throw new AttachmentError(400, "invalid multipart body"); }
        const entries = [...form.entries()];
        if (entries.length !== 2 || form.getAll("file").length !== 1 || form.getAll("instanceId").length !== 1) {
          throw new AttachmentError(400, "exactly one file and one instanceId required");
        }
        const file = form.get("file");
        if (file === null || typeof file === "string") throw new AttachmentError(400, "file required");
        if (form.get("instanceId") !== instanceId || !isCurrent()) throw new AttachmentError(409, "terminal instance changed");
        if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(413, "image exceeds 10 MiB");
        if (!file.size) throw new AttachmentError(415, "empty image");
        const bytes = Buffer.from(await file.arrayBuffer());
        // Gate signatures before invoking any decoder (in particular SVG/PDF).
        const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg"
          : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
        if (!format) throw new AttachmentError(415, "only PNG, JPEG and WebP images are supported");
        let width: number; let height: number;
        try {
          const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "warning" });
          const metadata = await image.metadata();
          if (metadata.format !== format || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
            throw new Error("unsupported image");
          }
          width = metadata.width; height = metadata.height;
          await image.stats(); // Header sniffing alone accepts truncated/corrupt images.
        } catch { throw new AttachmentError(415, "invalid image, animated image or image exceeds 25 megapixels"); }
        if (!isCurrent() || req.aborted) throw new AttachmentError(409, "terminal instance changed or upload aborted");
        await mkdir(base, { recursive: true, mode: 0o700 });
        const canonicalBase = await realpath(base);
        // Never interpolate the externally supplied session ID or filename into a path.
        const sessionDirectory = join(canonicalBase, key);
        await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
        if (await realpath(sessionDirectory) !== sessionDirectory) throw new AttachmentError(403, "invalid attachment directory");
        const id = randomUUID();
        const name = `${id}.${format === "jpeg" ? "jpg" : format}`;
        const path = join(sessionDirectory, name);
        const temporary = join(sessionDirectory, `.${id}.tmp`);
        const output = await open(temporary, "wx", 0o600);
        let committed = false;
        try {
          try { await output.writeFile(bytes); await output.sync(); }
          finally { await output.close(); }
          if (!isCurrent() || req.aborted) throw new AttachmentError(409, "terminal instance changed or upload aborted");
          await rename(temporary, path);
          committed = true;
          if (!isCurrent() || req.aborted) {
            await unlink(path);
            throw new AttachmentError(409, "terminal instance changed or upload aborted");
          }
          return { id, name, path, mime: `image/${format}`, size: bytes.length, width, height, sessionId, instanceId };
        } finally {
          if (!committed) await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
      } finally { active--; const count=(uploading.get(key)??1)-1; if(count)uploading.set(key,count);else uploading.delete(key); }
    },
  };
}
export type AttachmentStore = ReturnType<typeof createAttachmentStore>;
