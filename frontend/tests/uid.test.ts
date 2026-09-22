import assert from "node:assert/strict";
import { test } from "node:test";
import { uid } from "../src/shared/uid.ts";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uid falls back when crypto.randomUUID is missing outside a secure context", () => {
  // http:// 且非 localhost 时浏览器不提供 randomUUID，直接调用会抛错并让资料库不可用。
  // getRandomValues 没有这个限制，所以退路必须只依赖它。
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = uid();
      assert.match(id, V4, "版本位与变体位必须符合 RFC 4122 v4");
      ids.add(id);
    }
    assert.equal(ids.size, 500, "不得重复");
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, "randomUUID", original);
  }
});

test("uid uses the native implementation when it is available", () => {
  let calls = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID")!;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => { calls++; return "11111111-2222-4333-8444-555555555555"; }, configurable: true,
  });
  try {
    assert.equal(uid(), "11111111-2222-4333-8444-555555555555");
    assert.equal(calls, 1);
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", original);
  }
});
