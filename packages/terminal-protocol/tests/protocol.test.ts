import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { MAX_SNAPSHOT_LENGTH, MAX_WS_BYTES, PROTOCOL_VERSION, parseClientMessage } from "../src/index.ts";

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));
test("legacy ready and v2 cursor handshake remain compatible", () => {
  assert.deepEqual(parse({ type: "ready", haveSnapshot: true, preferRaw: false }), {
    type: "ready", haveSnapshot: true, preferRaw: false,
  });
  const ready = { type: "ready", protocol: PROTOCOL_VERSION, instanceId: "session-generation", afterSeq: 0, cols: 80, rows: 24 };
  assert.deepEqual(parse(ready), ready);
  assert.deepEqual(parse({ type: "ready" }), { type: "ready" });
});

test("invalid JSON, primitive bodies and unknown message types are rejected", () => {
  assert.throws(() => parseClientMessage("{"));
  for (const value of [null, [], 1, "ready", {}, { type: ["ready"] }, { type: "output" }]) {
    assert.throws(() => parse(value));
  }
  for (const type of ["input", "snapshot"]) {
    for (const data of [null, 1, [], {}]) assert.throws(() => parse({ type, data }), /data string/);
    assert.equal(parse({ type, data: "" }).data, "");
  }
});

test("dimensions must be a complete integer pair inside the terminal bounds", () => {
  for (const size of [0, -1, 1.5, 1001, "80", null]) {
    assert.throws(() => parse({ type: "resize", cols: size, rows: 24 }), /dimensions/);
    assert.throws(() => parse({ type: "ready", cols: 80, rows: size }), /dimensions/);
  }
  assert.throws(() => parse({ type: "ready", cols: 80 }), /dimensions/);
  assert.throws(() => parse({ type: "resize" }), /dimensions/);
  for (const size of [1, 1000]) assert.equal(parse({ type: "resize", cols: size, rows: size }).cols, size);
  assert.throws(() => parse({ type: "ready", haveSnapshot: "yes" }), /flag/);
  assert.throws(() => parse({ type: "ready", preferRaw: 0 }), /flag/);
});

test("output cursors require a bounded instance and a nonnegative safe integer", () => {
  for (const key of ["seq", "afterSeq"]) {
    for (const seq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      assert.throws(() => parse({ type: "ready", instanceId: "a", [key]: seq }), /sequence/);
    }
    assert.throws(() => parse({ type: "ready", [key]: 0 }), /instance required/);
    assert.equal(parse({ type: "ready", instanceId: "a", [key]: Number.MAX_SAFE_INTEGER })[key as "seq" | "afterSeq"], Number.MAX_SAFE_INTEGER);
  }
  for (const instanceId of ["", "x".repeat(129), 1, null]) {
    assert.throws(() => parse({ type: "ready", instanceId }), /instance/);
  }
  assert.throws(() => parse({ type: "ready", protocol: 1 }), /protocol/);
  assert.throws(() => parse({ type: "ready", protocol: "2" }), /protocol/);
});

test("snapshot and transport limits account for escaped control characters", () => {
  assert.equal(MAX_SNAPSHOT_LENGTH, 512000);
  assert.equal(MAX_WS_BYTES, 8 * 1024 * 1024);
  const message = { type: "snapshot", data: "\x1b".repeat(MAX_SNAPSHOT_LENGTH), instanceId: "a", seq: 0 };
  const encoded = JSON.stringify(message);
  assert.ok(new TextEncoder().encode(encoded).length < MAX_WS_BYTES);
  assert.deepEqual(parseClientMessage(encoded), message);
});

test("the shared entrypoint contains no Node or UI runtime dependency", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:import|require)\s*(?:\(|.*?from\s*)["'](?:node:|react|ws["'])/);
  assert.doesNotMatch(source, /\b(?:Buffer|process|window|document|require)\b/);
});

test('heartbeat nonce must be a nonnegative safe integer', () => {
  assert.deepEqual(parse({ type: 'ping', nonce: 42 }), { type: 'ping', nonce: 42 });
  for (const nonce of [undefined, null, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parse({ type: 'ping', nonce }), /heartbeat nonce/);
  }
});
