import assert from "node:assert/strict";
import { test } from "node:test";
import { pickSnapshot } from "../src/features/terminal/engine/snapshot";

/*
  超限的快照是整份丢掉的，所以 pickSnapshot 要**先退级再序列化**，而不是序列化完看长度。
  这里注入一个假 serialize：它按行数返回不同长度，并记下每一级被问过没有——真终端要往里
  灌两万行才能测到同一件事。
*/
function fakeSerialize(sizeOf: (scrollback: number) => number) {
  const asked: number[] = [];
  return {
    asked,
    serialize: (scrollback: number) => {
      asked.push(scrollback);
      return "X".repeat(sizeOf(scrollback));
    },
  };
}

test("装得下就用最深的那一级，不去试更浅的", () => {
  const fake = fakeSerialize(() => 100);
  const snapshot = pickSnapshot(fake.serialize, "SUFFIX", false, 1000);
  assert.equal(snapshot, "X".repeat(100) + "SUFFIX");
  assert.deepEqual(fake.asked, [2000], "第一级就装得下，不该再序列化一遍");
});

test("超限时逐级退到 500 行、再退到只剩当前屏", () => {
  // 2000 行 1200 字节、500 行 600 字节、只剩视口 200 字节。
  const size = (scrollback: number) => (scrollback === 2000 ? 1200 : scrollback === 500 ? 600 : 200);
  const toFiveHundred = fakeSerialize(size);
  assert.equal(pickSnapshot(toFiveHundred.serialize, "", false, 1000)?.length, 600);
  assert.deepEqual(toFiveHundred.asked, [2000, 500]);

  const toViewport = fakeSerialize(size);
  assert.equal(pickSnapshot(toViewport.serialize, "", false, 500)?.length, 200);
  assert.deepEqual(toViewport.asked, [2000, 500, 0], "500 行也超限就该再退一级");
});

test("连当前屏都超限时给 null，而不是给一份会被整份丢掉的", () => {
  const fake = fakeSerialize(() => 200);
  assert.equal(pickSnapshot(fake.serialize, "", false, 50), null);
  assert.deepEqual(fake.asked, [2000, 500, 0], "三级都要试过才认输");
});

test("后缀算在长度里——它和屏幕内容一起发出去", () => {
  const fake = fakeSerialize(() => 90);
  // 90 + 20 = 110 > 100：光看屏幕内容会以为装得下。
  assert.equal(pickSnapshot(fake.serialize, "S".repeat(20), false, 100), null);
  assert.equal(pickSnapshot(fake.serialize, "S".repeat(10), false, 100)?.length, 100);
});

test("TUI 还在跑时补上 SGR 鼠标模式，已经带了就不重复补", () => {
  // 少了这一条，恢复出来的屏看着对，而滚轮在 TUI 里忽然不灵了。
  const plain = pickSnapshot(() => "screen", "", true, 1000);
  assert.equal(plain, "screen\x1b[?1006h");
  // 序列化自己带上了就不该再补一遍。
  const already = pickSnapshot(() => "screen\x1b[?1006h", "", true, 1000);
  assert.equal(already, "screen\x1b[?1006h");
  // 不在 TUI 里就不许凭空给终端开鼠标模式。
  assert.equal(pickSnapshot(() => "screen", "", false, 1000), "screen");
});

test("什么都没有时给 null，而不是一个空字符串快照", () => {
  // 空快照和「有一份快照」在调用方那边是两件事：前者该走全量重建那条路。
  assert.equal(pickSnapshot(() => "", "", false, 1000), null);
});
