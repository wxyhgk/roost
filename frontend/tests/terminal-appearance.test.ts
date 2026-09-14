import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@xterm/xterm";
import { attachAppearance } from "../src/features/terminal/engine/appearance";

const dark = { background: "#000000", foreground: "#f5f5f7", cursor: "#ffffff", cursorAccent: "#000000", selectionBackground: "#48484a" };
const light = { ...dark, background: "#ffffff", foreground: "#000000" };
const sleep = () => new Promise(resolve => setTimeout(resolve, 60));
function fixture() {
  const handlers = new Map<string, (params: any) => boolean>();
  const register = (key: string, fn: any) => { handlers.set(key, fn); return { dispose: () => handlers.delete(key) }; };
  const parser = {
    registerCsiHandler: (id: any, fn: any) => register(`${id.prefix ?? ""}${id.intermediates ?? ""}${id.final}`, fn),
    registerOscHandler: (id: number, fn: any) => register(`OSC${id}`, fn),
    registerEscHandler: (id: any, fn: any) => register(`ESC${id.final}`, fn),
  } as Terminal["parser"];
  const replies: string[] = [];
  const appearance = attachAppearance({ parser }, dark, data => replies.push(data));
  appearance.setOwner(true);
  appearance.setReady(true);
  return { appearance, replies, csi: (key: string, params: number[]) => handlers.get(key)!(params) };
}

test("color queries report current palette; no unsolicited reports to a shell", async () => {
  const t = fixture();
  t.csi("?$p", [2031]);
  t.appearance.forwardColorResponse("\x1b]10;rgb:f5f5/f5f5/f7f7\x1b\\");
  t.appearance.forwardColorResponse("\x1b]11;rgb:0000/0000/0000\x1b\\");
  assert.deepEqual(t.replies, ["\x1b[?2031;2$y", "\x1b]10;rgb:f5f5/f5f5/f7f7\x1b\\", "\x1b]11;rgb:0000/0000/0000\x1b\\"]);
  t.replies.length = 0;
  t.appearance.setTheme(light);
  await sleep();
  assert.deepEqual(t.replies, []);
  t.csi("?n", [996]);
  assert.deepEqual(t.replies, ["\x1b[?997;2n"]);
  assert.equal(t.csi("?n", [6]), false);
  assert.equal(t.appearance.forwardColorResponse("user input"), false);
  t.appearance.dispose();
});

test("subscribed updates coalesce and cancellation prevents a late notification", async () => {
  const t = fixture();
  assert.equal(t.csi("?h", [1006, 2031]), false);
  t.appearance.setTheme(light); t.appearance.setTheme(dark); t.appearance.setTheme(light);
  await sleep();
  assert.deepEqual(t.replies, ["\x1b[?997;2n"]);
  t.appearance.setTheme(dark);
  t.csi("?l", [2031]);
  await sleep();
  assert.equal(t.replies.length, 1);
  t.appearance.dispose();
});

test("replay restores subscriptions without answering historical probes; reconnect reports once ready", async () => {
  const t = fixture();
  t.appearance.setReady(false);
  t.appearance.setReplaying(true);
  t.csi("?h", [2031]); t.csi("?n", [996]); t.appearance.forwardColorResponse("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
  assert.equal(t.appearance.snapshot(), "\x1b[?2031h");
  t.appearance.setTheme(light);
  t.appearance.setReplaying(false);
  await sleep();
  assert.deepEqual(t.replies, []);
  t.appearance.setReady(true);
  await sleep();
  assert.deepEqual(t.replies, ["\x1b[?997;2n"]);
  t.appearance.reset();
  assert.equal(t.appearance.snapshot(), "");
  t.appearance.setTheme(dark);
  await sleep();
  assert.equal(t.replies.length, 1);
  t.appearance.dispose();
});

test("a passive view cannot answer or notify; ownership transfer uses its current colors", async () => {
  const t = fixture();
  t.appearance.setOwner(false);
  t.csi("?h", [2031]); t.appearance.forwardColorResponse("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"); t.csi("?$p", [2031]);
  t.appearance.setTheme(light);
  await sleep();
  assert.deepEqual(t.replies, []);
  t.appearance.setOwner(true);
  await sleep();
  assert.deepEqual(t.replies, ["\x1b[?997;2n"]);
  t.appearance.dispose();
});
