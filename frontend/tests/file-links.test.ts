import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFileLinks, matchFileLinks, resolveLinkTarget } from "../src/features/terminal/fileLinks.ts";

test("python traceback yields path and line with exact spans", () => {
  const text = '  File "/Users/a/b.py", line 123, in main';
  const [m] = matchFileLinks(text);
  assert.equal(m.path, "/Users/a/b.py");
  assert.equal(m.line, 123);
  assert.equal(text.slice(m.start, m.end), "/Users/a/b.py");
});

test("generic path with line and column", () => {
  const text = "error at src/app.ts:10:5 exploded";
  const [m] = matchFileLinks(text);
  assert.equal(m.path, "src/app.ts");
  assert.equal(m.line, 10);
  assert.equal(text.slice(m.start, m.end), "src/app.ts:10:5");
});

test("relative, dot and home prefixes", () => {
  assert.equal(matchFileLinks("./a.py:3")[0].path, "./a.py");
  assert.equal(matchFileLinks("../a.py")[0].path, "../a.py");
  assert.equal(matchFileLinks("~/x/b.json")[0].path, "~/x/b.json");
  assert.equal(matchFileLinks("a.py")[0].line, undefined);
});

test("quoted and parenthesized paths", () => {
  assert.equal(matchFileLinks('"src/a.py"')[0].path, "src/a.py");
  assert.equal(matchFileLinks("(src/a.py:7)")[0].path, "src/a.py");
  assert.equal(matchFileLinks("see a.py, then")[0].path, "a.py");
});

test("non-paths are ignored", () => {
  assert.deepEqual(matchFileLinks("version 1.2.3 released"), []);
  assert.deepEqual(matchFileLinks("see https://x.io/y.py:9 docs"), []);
  assert.deepEqual(matchFileLinks("just some words"), []);
  assert.deepEqual(matchFileLinks("noext error here"), []);
});

test("traceback span is not double matched and results sort by position", () => {
  const text = 'b.json:1 File "/a.py", line 2';
  const ms = matchFileLinks(text);
  assert.deepEqual(
    ms.map((m) => [m.path, m.line]),
    [["b.json", 1], ["/a.py", 2]],
  );
});

test("built links use 1-based half-open columns", () => {
  const text = '  File "/a.py", line 2';
  const [m] = buildFileLinks(text);
  assert.equal(m.path, "/a.py");
  assert.equal(m.line, 2);
  assert.equal(m.startX, text.indexOf("/a.py") + 1);
  assert.equal(m.endX, text.indexOf("/a.py") + "/a.py".length + 1);
  assert.ok(m.startX >= 1 && m.endX > m.startX);
});

test("resolveLinkTarget jails to the session root", () => {
  const cwd = "/Users/a/proj";
  assert.equal(resolveLinkTarget(cwd, "src/b.py"), "src/b.py");
  assert.equal(resolveLinkTarget(cwd, "./src/b.py"), "src/b.py");
  assert.equal(resolveLinkTarget(cwd, `${cwd}/src/b.py`), "src/b.py");
  assert.equal(resolveLinkTarget(cwd, "../evil.py"), null);
  assert.equal(resolveLinkTarget(cwd, "/etc/passwd"), null);
  assert.equal(resolveLinkTarget(cwd, `${cwd}/../evil.py`), null);
  assert.equal(resolveLinkTarget(cwd, ""), null);
  assert.equal(resolveLinkTarget(cwd, `${cwd}`), null);
});

test('Chinese paths, quoted spaces and frontend/image extensions are recognized completely', () => {
  assert.equal(matchFileLinks('修改 项目/组件/入口.tsx:12')[0].path, '项目/组件/入口.tsx');
  const [quoted] = matchFileLinks('打开 "/Users/a/My Project/图标.svg":7');
  assert.equal(quoted.path, '/Users/a/My Project/图标.svg');
  assert.equal(quoted.line, 7);
  assert.equal(matchFileLinks('src/theme.css')[0].path, 'src/theme.css');
  assert.equal(matchFileLinks('images/demo.png')[0].path, 'images/demo.png');
  assert.deepEqual(matchFileLinks('https://host/a-b/src/组件.tsx?q=foo.py'), []);
  assert.deepEqual(matchFileLinks('image.png.backup'), []);
});
