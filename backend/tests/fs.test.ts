import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import { promisify } from "node:util";

const root = await fs.mkdtemp(join(tmpdir(), "roost-preview-test-"));
const realOpen = fs.open;
const execFileAsync = promisify(execFile);
let shortReadLimit = Infinity;
let failRead = false;
let failStat = false;
let closed = 0;
let transferred = 0;
let reads: { position: number; length: number }[] = [];

mock.module("node:fs/promises", {
  namedExports: {
    readdir: fs.readdir,
    realpath: fs.realpath, rename: fs.rename, unlink: fs.unlink, stat: fs.stat, mkdir: fs.mkdir, rm: fs.rm,
    open: async (path: string, flags: string | number) => {
      const handle = await realOpen(path, flags);
      return {
        stat: () => {
          if (failStat) throw new Error("injected stat failure");
          return handle.stat();
        },
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          reads.push({ position, length });
          if (failRead) throw new Error("injected read failure");
          const result = await handle.read(buffer, offset, Math.min(length, shortReadLimit), position);
          transferred += result.bytesRead;
          return result;
        },
        close: async () => {
          closed++;
          await handle.close();
        },
      };
    },
  },
});

const { readPreview, MAX_PREVIEW_BYTES: LIMIT } = await import("../src/fs.ts");

beforeEach(() => {
  shortReadLimit = Infinity;
  failRead = false;
  failStat = false;
  closed = 0;
  transferred = 0;
  reads = [];
});
after(async () => {
  mock.restoreAll();
  await fs.rm(root, { recursive: true, force: true });
});

function assertBoundedRead() {
  assert.ok(transferred <= LIMIT + 1);
  for (const read of reads) {
    assert.ok(read.position + read.length <= LIMIT + 1);
  }
  assert.equal(closed, 1);
}

test("normal UTF-8 text and empty files retain preview metadata", async () => {
  const content = "hello 中文\n";
  await fs.writeFile(join(root, "normal.txt"), content);
  assert.deepEqual(await readPreview(root, "normal.txt"), {
    mtime: (await fs.stat(join(root, "normal.txt"))).mtimeMs,
    name: "normal.txt", path: "normal.txt", binary: false, truncated: false, content,
  });
  assertBoundedRead();
  closed = 0;
  transferred = 0;
  reads = [];
  await fs.writeFile(join(root, "empty.txt"), "");
  assert.equal((await readPreview(root, "empty.txt")).content, "");
  assertBoundedRead();
});

test("exact limit is not truncated and a large file reads only limit plus one", async () => {
  await fs.writeFile(join(root, "boundary.txt"), Buffer.alloc(LIMIT, 97));
  const boundary = await readPreview(root, "boundary.txt");
  assert.equal(boundary.truncated, false);
  assert.equal(boundary.content.length, LIMIT);
  assertBoundedRead();
  closed = 0;
  transferred = 0;
  reads = [];
  await fs.writeFile(join(root, "large.txt"), Buffer.alloc(LIMIT * 8, 98));
  const large = await readPreview(root, "large.txt");
  assert.equal(large.truncated, true);
  assert.equal(large.content, "b".repeat(LIMIT));
  assert.equal(transferred, LIMIT + 1);
  assertBoundedRead();
});

test("large binary preview preserves binary semantics with bounded reads", async () => {
  await fs.writeFile(join(root, "binary.dat"), Buffer.alloc(LIMIT * 4));
  assert.deepEqual(await readPreview(root, "binary.dat"), {
    mtime: (await fs.stat(join(root, "binary.dat"))).mtimeMs,
    name: "binary.dat", path: "binary.dat", binary: true, truncated: false, content: "",
  });
  assertBoundedRead();
});

test("short reads continue to EOF without dropping text", async () => {
  shortReadLimit = 3;
  const content = "short reads 中文 remain complete";
  await fs.writeFile(join(root, "short.txt"), content);
  const preview = await readPreview(root, "short.txt");
  assert.equal(preview.content, content);
  assert.equal(preview.truncated, false);
  assert.ok(reads.length > 2);
  assertBoundedRead();
});

test("short reads stop at the preview limit and correctly mark truncation", async () => {
  shortReadLimit = 8191;
  await fs.writeFile(join(root, "short-large.txt"), Buffer.alloc(LIMIT * 2, 99));
  const preview = await readPreview(root, "short-large.txt");
  assert.equal(preview.content, "c".repeat(LIMIT));
  assert.equal(preview.truncated, true);
  assert.equal(transferred, LIMIT + 1);
  assertBoundedRead();
});

test("read and stat failures close the file handle", async () => {
  await fs.writeFile(join(root, "failure.txt"), "text");
  failRead = true;
  await assert.rejects(readPreview(root, "failure.txt"), /injected read failure/);
  assert.equal(closed, 1);
  failRead = false;
  failStat = true;
  closed = 0;
  await assert.rejects(readPreview(root, "failure.txt"), /injected stat failure/);
  assert.equal(closed, 1);
});

test("directories are rejected and their handle is closed without reading", async () => {
  await assert.rejects(readPreview(root, "."), /not a file/);
  assert.equal(reads.length, 0);
  assert.equal(closed, 1);
});

test("a FIFO without a writer is promptly rejected", { skip: process.platform === "win32" }, async () => {
  await execFileAsync("mkfifo", [join(root, "pipe")], { timeout: 3000 });
  // Isolate the real read in a killable process: a regression to blocking open
  // cannot strand the test runner's fs thread or prevent temporary-file cleanup.
  await execFileAsync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import assert from "node:assert/strict";
     const { readPreview } = await import(process.argv[2]);
     await assert.rejects(readPreview(process.argv[1], "pipe"), /not a file/);`,
    root, new URL("../src/fs.ts", import.meta.url).href,
  ], { timeout: 5000, killSignal: "SIGKILL" });
});
