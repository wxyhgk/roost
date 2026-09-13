import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, rename, unlink, stat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

/**
 * 列目录时跳过的条目。监听器也用同一份：列目录看不见的东西，
 * 变化了也没有通知的意义，而 node_modules / .git 的事件量足以淹掉整条通道。
 */
export const HIDDEN = new Set([".git", "node_modules", "dist", ".DS_Store"]);

/** 相对路径上任何一段命中忽略名单就算被忽略——监听是递归的，只看首段不够。 */
export function isHidden(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(segment => HIDDEN.has(segment) || (segment.startsWith(".diy-upload-") && segment.endsWith(".tmp")));
}

export type FileNode = {
  name: string;
  kind: "file" | "dir";
  path: string;
};

export function assertInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("path escapes workspace");
  }
}

export async function listDir(root: string, relPath = ""): Promise<FileNode[]> {
  const dir = resolve(root, relPath);
  assertInside(root, dir);
  const canonicalRoot = await realpath(root), canonicalDir = await realpath(dir);
  assertInside(canonicalRoot, canonicalDir);
  const entries = await readdir(canonicalDir, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const kind = entry.isDirectory() ? "dir" : "file";
    const path = relPath ? `${relPath}/${entry.name}` : entry.name;
    nodes.push({ name: entry.name, kind, path });
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

/**
 * 快速切换里搜文件时**额外**跳过的目录。
 *
 * 比 HIDDEN 宽，因为这两件事的代价不同：列目录只看一层，进不进 `target/` 无所谓；
 * 而搜索是递归的，一个 `.venv` 就能把预算吃光，让真正想找的源码挤不进结果。
 *
 * 只按目录名匹配，不看路径——一个叫 `build` 的目录不管在哪一层都不值得走进去。
 */
const SEARCH_SKIP = new Set([
  "build", ".next", "out", "coverage", "target", "vendor",
  "__pycache__", ".venv", "venv", ".idea", ".vscode",
]);

export type WalkFile = { path: string; name: string };

/**
 * 按广度优先列出 root 下的文件，给快速切换搜索用。
 *
 * **为什么在服务端走而不是前端逐层请求**：前端那版一层一个往返，实测这个仓库要
 * 106 个请求、6 层串行——HTTP/2 上光往返就 2 秒，HTTP/1.1（每源 6 连接）近 6 秒。
 * 同样的遍历在服务端是本地磁盘操作，毫秒级；而且关掉面板时那 106 个请求还会在后台
 * 跑完，占着连接挡住用户真正在等的东西。
 *
 * 广度优先而不是深度优先：预算用完时，留下的是浅层的文件，而那正是人更可能在找的。
 *
 * 每一层都重新做 realpath + assertInside，所以符号链接指到 root 外面时会被挡住，
 * 不会顺着它走出去。
 */
export async function walkFiles(
  root: string,
  { depth = 6, limit = 3000 }: { depth?: number; limit?: number } = {},
): Promise<{ files: WalkFile[]; truncated: boolean }> {
  const files: WalkFile[] = [];
  let level: string[] = [""];
  let level_ = 0;
  while (level.length && files.length < limit && level_ <= depth) {
    const next: string[] = [];
    for (const rel of level) {
      let nodes: FileNode[];
      // 单个目录读不动（权限、刚被删掉）不该让整次搜索失败——跳过它继续。
      try { nodes = await listDir(root, rel); } catch { continue; }
      for (const node of nodes) {
        if (node.kind === "file") {
          if (files.length >= limit) break;
          files.push({ path: node.path, name: node.name });
        } else if (level_ < depth && !SEARCH_SKIP.has(node.name)) {
          next.push(node.path);
        }
      }
    }
    level = next;
    level_++;
  }
  return { files, truncated: files.length >= limit };
}

// Text preview/edit cap: single-user local app, keep preview and save limits
// identical so a fully previewed file is always saveable (no read-only gap).
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

function looksBinary(buf: Buffer) {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

export async function readPreview(root: string, relPath: string, maxBytes = MAX_PREVIEW_BYTES) {
  const file = await resolveFile(root, relPath);
  // A FIFO must reach the file-type check without waiting for a writer.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let buf: Buffer;
  let mtime: number;
  try {
    const info = await handle.stat();
    mtime = info.mtimeMs;
    if (!info.isFile()) throw new Error("not a file");
    // One extra byte distinguishes a full preview from a truncated file.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    buf = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  if (looksBinary(buf)) {
    return {
      mtime,
      name: basename(file),
      path: relPath,
      binary: true,
      truncated: false,
      content: "",
    };
  }
  const truncated = buf.length > maxBytes;
  const slice = truncated ? buf.subarray(0, maxBytes) : buf;
  return {
    mtime,
    name: basename(file),
    path: relPath,
    binary: false,
    truncated,
    content: slice.toString("utf8"),
  };
}

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Raw binary serving (images, PDFs) streams from disk; cap well above preview
// limits but far below memory-exhaustion territory for a local single user.
export const MAX_RAW_BYTES = 64 * 1024 * 1024;

const RAW_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  pdf: "application/pdf",
};

export function contentTypeFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return RAW_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export type RawFile = {
  file: string;
  name: string;
  size: number;
  mtime: number;
  contentType: string;
};

// Resolve + stat only; the caller streams the bytes. Same traversal rules as
// readPreview: FIFOs, directories and escapes are rejected before any read.
export async function statRawFile(root: string, relPath: string): Promise<RawFile> {
  const file = await resolveFile(root, relPath);
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a file");
    return {
      file,
      name: basename(file),
      size: info.size,
      mtime: info.mtimeMs,
      contentType: contentTypeFor(basename(file)),
    };
  } finally {
    await handle.close();
  }
}
// JSON can escape each content byte as six ASCII bytes (e.g. \u0001).
export const MAX_FILE_REQUEST_BYTES = MAX_FILE_BYTES * 6 + 64 * 1024;

export class FileWriteError extends Error {
  constructor(public readonly status: number, message: string, public readonly current?: Awaited<ReturnType<typeof readPreview>>) {
    super(message);
  }
}

async function resolveFile(root: string, relPath: string) {
  const requested = resolve(root, relPath);
  assertInside(root, requested);
  const canonicalRoot = await realpath(root);
  const file = await realpath(requested);
  assertInside(canonicalRoot, file);
  return file;
}

// Serialize saves to the same canonical file so two editor tabs cannot both win.
const saves = new Map<string, Promise<unknown>>();
export async function writeFileAtomic(root: string, relPath: string, content: string, mtime: number) {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_FILE_BYTES) throw new FileWriteError(413, "file content too large");
  if (bytes.includes(0)) throw new FileWriteError(415, "binary content is not editable");
  const file = await resolveFile(root, relPath);
  const previous = saves.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const conflict = async () => { throw new FileWriteError(409, "file changed", await readPreview(root, relPath, MAX_FILE_BYTES)); };
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    let original;
    try {
      original = await handle.stat();
      if (!original.isFile()) throw new FileWriteError(400, "not a file");
      if (original.mtimeMs !== mtime) return await conflict();
      if (original.size > MAX_FILE_BYTES) throw new FileWriteError(413, "existing file too large to edit");
      // Scan the existing file too; replacing a binary file with text is unsafe.
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < original.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, original.size - offset), offset);
        if (!bytesRead) break;
        if (buffer.subarray(0, bytesRead).includes(0)) throw new FileWriteError(415, "binary file is not editable");
        offset += bytesRead;
      }
    } finally { await handle.close(); }
    const temporary = resolve(dirname(file), `.diy-save-${randomUUID()}.tmp`);
    let created = false;
    try {
      const output = await open(temporary, "wx", 0o600);
      created = true;
      let saved;
      try {
        await output.writeFile(bytes);
        await output.chmod(original.mode & 0o777);
        saved = await output.stat();
        // Ensure even immediate successive saves invalidate the previous token.
        if (saved.mtimeMs <= original.mtimeMs) {
          // Linux may round an integer-millisecond utimes value down by a
          // microsecond. floor(old) + 1 can then reproduce old exactly.
          await output.utimes(saved.atime, new Date(Math.ceil(original.mtimeMs) + 1));
          saved = await output.stat();
          if (saved.mtimeMs <= original.mtimeMs) return await conflict();
        }
        await output.sync();
      } finally { await output.close(); }
      if (await resolveFile(root, relPath) !== file) return await conflict();
      const latest = await stat(file);
      if (latest.ino !== original.ino || latest.dev !== original.dev || latest.mtimeMs !== original.mtimeMs || latest.ctimeMs !== original.ctimeMs || latest.size !== original.size) return await conflict();
      await rename(temporary, file);
      return { mtime: saved.mtimeMs };
    } finally { if (created) await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  });
  saves.set(file, pending);
  try { return await pending; }
  finally { if (saves.get(file) === pending) saves.delete(file); }
}

// Resolve the canonical parent of a not-yet-existing path: the parent must
// exist and stay inside the root, blocking `../` escapes and evil symlinks.
async function resolveParent(root: string, relPath: string) {
  const requested = resolve(root, relPath);
  assertInside(root, requested);
  const canonicalRoot = await realpath(root);
  const parent = await realpath(dirname(requested));
  assertInside(canonicalRoot, parent);
  return { requested, canonicalRoot };
}

function existsError(error: unknown): never {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    throw new FileWriteError(409, "already exists");
  }
  throw error;
}

export async function createPath(root: string, relPath: string, kind: "file" | "dir") {
  const { requested } = await resolveParent(root, relPath);
  try {
    if (kind === "dir") await mkdir(requested);
    else await (await open(requested, "wx", 0o644)).close();
  } catch (error) {
    existsError(error);
  }
  return { name: basename(requested), path: relPath };
}

export async function renamePath(root: string, oldRel: string, newRel: string) {
  const from = resolve(root, oldRel);
  assertInside(root, from);
  const canonicalRoot = await realpath(root);
  const canonicalFrom = await realpath(from);
  assertInside(canonicalRoot, canonicalFrom);
  if (canonicalFrom === canonicalRoot) throw new FileWriteError(400, "cannot rename the workspace root");
  const { requested: to } = await resolveParent(root, newRel);
  try {
    await stat(to);
    throw new FileWriteError(409, "already exists");
  } catch (error) {
    if (error instanceof FileWriteError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(canonicalFrom, to);
  return { name: basename(to), path: newRel };
}

export async function deletePath(root: string, relPath: string) {
  const requested = resolve(root, relPath);
  assertInside(root, requested);
  const canonicalRoot = await realpath(root);
  const file = await realpath(requested);
  assertInside(canonicalRoot, file);
  if (file === canonicalRoot) throw new FileWriteError(400, "cannot delete the workspace root");
  await rm(file, { recursive: true });
  return { ok: true };
}
