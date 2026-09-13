import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteShellPath } from "../src/features/terminal/paths.ts";

test("plain relative paths pass through unquoted", () => {
  for (const p of ["src/foo.ts", "a-b_c/d.e", "README.md"]) {
    assert.equal(quoteShellPath(p), p);
  }
});

test("spaces and shell metachars get double-quoted with escapes", () => {
  assert.equal(quoteShellPath("my dir/file.ts"), '"my dir/file.ts"');
  assert.equal(quoteShellPath('a"b.ts'), '"a\\"b.ts"');
  assert.equal(quoteShellPath("a$b.ts"), '"a\\$b.ts"');
  assert.equal(quoteShellPath("a`b.ts"), '"a\\`b.ts"');
  assert.equal(quoteShellPath("as-is (v2).ts"), '"as-is (v2).ts"');
});
