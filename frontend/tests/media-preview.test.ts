import assert from "node:assert/strict";
import { test } from "node:test";
import { rawFileUrl } from "../src/shared/api/index.ts";
import { imagePlugin, pdfPlugin } from "../src/plugins/media/index.tsx";

test("image plugin matches raster/vector extensions but not pdf or text", () => {
  for (const name of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.svg", "a.ico", "a.avif"]) {
    assert.equal(imagePlugin.match(name), true, name);
  }
  for (const name of ["a.pdf", "a.txt", "a.xyz", "png.txt"]) {
    assert.equal(imagePlugin.match(name), false, name);
  }
});

test("pdf plugin matches only pdf", () => {
  assert.equal(pdfPlugin.match("a.pdf"), true);
  assert.equal(pdfPlugin.match("a.PDF"), true);
  assert.equal(pdfPlugin.match("a.png"), false);
  assert.equal(pdfPlugin.match("pdf.txt"), false);
});

test("raw file url encodes root and path", () => {
  const url = rawFileUrl("/tmp/a b", "sub/x.png");
  assert.ok(url.startsWith("/api/file/raw?"), url);
  const q = new URLSearchParams(url.slice("/api/file/raw?".length));
  assert.equal(q.get("root"), "/tmp/a b");
  assert.equal(q.get("path"), "sub/x.png");
});
