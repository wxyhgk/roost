import test from "node:test";
import assert from "node:assert/strict";
import type { TerminalService } from "@roost/terminal-runtime";
import type { AgentJournalEvent, AgentReplay } from "@roost/terminal-protocol";
import { AiIdentityError, readIdentityCandidate } from "../src/ai-identity.ts";

const expected = { terminalInstanceId: "i", cliId: "omp" };
function event(sourceSeq: number, nativeId?: string, transcriptPath?: string): AgentJournalEvent {
  return { terminalInstanceId: "i", sourceSeq, agent: { event: "session_start", sessionId: nativeId, transcriptPath } };
}
function page(events: AgentJournalEvent[], highWater: number, cursor = events.at(-1)?.sourceSeq ?? 0): AgentReplay {
  return { events, highWater, cursor, more: cursor < highWater, hasGap: false };
}
function fixture(pages: AgentReplay[]) {
  const state = { connected: true, capable: true, instance: "i", cli: "omp", calls: [] as number[], hook: (_call: number) => {} };
  const runtime = {
    isConnected: () => state.connected,
    supportsAgentReplay: () => state.capable,
    getSession: () => ({ id: "s", instanceId: state.instance, cli: state.cli, pid: 1, cwd: "/" }),
    readAgentEvents: async (_id: string, _instance: string, after: number) => {
      state.calls.push(after); state.hook(state.calls.length);
      const result = pages.shift(); if (!result) throw new Error("unexpected read"); return result;
    },
  } as unknown as TerminalService;
  return { state, run: (options: { afterSeq?: number; requireExplicitCli?: boolean } = {}) => readIdentityCandidate(runtime, "s", { ...expected, ...options }) };
}
const code = (expectedCode: string) => (error: unknown) => error instanceof AiIdentityError && error.status === 409 && error.code === expectedCode;

test("identity scan finds latest boundary, updates only its explicit metadata, and verifies an empty tail", async () => {
  const f = fixture([
    page([event(1, "a", "/a"), event(2, "b", "/old-b")], 5),
    page([event(3, "b", "/b"), event(4, undefined, "/unattributed"), event(5, "b")], 5),
    page([], 5, 5),
  ]);
  assert.deepEqual(await f.run(), { nativeSessionId: "b", boundarySeq: 2, highWater: 5, transcriptPath: "/b" });
  assert.deepEqual(f.state.calls, [0, 2, 5]);
  const back = fixture([page([event(1, "a", "/a"), event(2, "b"), event(3, "a")], 3), page([], 3, 3)]);
  assert.deepEqual(await back.run(), { nativeSessionId: "a", boundarySeq: 3, highWater: 3 });
});

test("identity scan refuses growing or shrinking high water and activity at tail verification", async () => {
  for (const next of [page([event(2, "b")], 3), page([], 1, 1)]) {
    await assert.rejects(fixture([page([event(1, "a")], 2), next]).run(), code("source_changed"));
  }
  await assert.rejects(fixture([page([event(1, "a")], 1), page([event(2, "b")], 2)]).run(), code("source_changed"));
});

test("identity scan refuses journal gaps, duplicate or unordered sequences and dishonest progress", async () => {
  const invalid = [
    { ...page([event(1, "a")], 1), hasGap: true },
    page([event(2, "a")], 2),
    page([event(1, "a"), event(1, "b")], 2),
    page([event(2, "a"), event(1, "b")], 2),
    page([event(1, "a")], 1, 2),
    { ...page([event(1, "a")], 2), more: false },
    page([], 1),
  ];
  for (const item of invalid) await assert.rejects(fixture([item]).run(), code("source_gap"));
  await assert.rejects(fixture([page([event(1, "a")], 1), { ...page([], 1, 1), hasGap: true }]).run(), code("source_gap"));
});

test("identity scan rechecks runtime around asynchronous reads and validates event instance", async () => {
  for (const mutation of [
    (s: ReturnType<typeof fixture>["state"]) => { s.instance = "replacement"; },
    (s: ReturnType<typeof fixture>["state"]) => { s.cli = "other"; },
  ]) {
    for (const changeAt of [1, 2]) {
      const f = fixture([page([event(1, "a")], 1), page([], 1, 1)]);
      f.state.hook = count => { if (count === changeAt) mutation(f.state); };
      await assert.rejects(f.run(), code("terminal_changed"));
    }
  }
  const f = fixture([page([{ ...event(1, "a"), terminalInstanceId: "other" }], 1)]);
  await assert.rejects(f.run(), code("terminal_changed"));
  for (const field of ["connected", "capable"] as const) {
    const f = fixture([page([event(1, "a")], 1)]); f.state.hook = () => { f.state[field] = false; };
    await assert.rejects(f.run(), code("source_unavailable"));
  }
  await assert.rejects(fixture([]).run(), code("source_unavailable"));
});

test("identity scan refuses empty/unidentified journals and bounds work to 64 pages", async () => {
  await assert.rejects(fixture([page([], 0), page([], 0)]).run(), code("identity_unconfirmed"));
  await assert.rejects(fixture([page([event(1)], 1), page([], 1, 1)]).run(), code("identity_unconfirmed"));
  const f = fixture(Array.from({ length: 65 }, (_, i) => page([event(i + 1, "a")], 65)));
  await assert.rejects(f.run(), code("source_changed"));
  assert.equal(f.state.calls.length, 64);
});


test("manual identity scan ignores foreign CLI native IDs and paths without creating sequence gaps", async () => {
  const own = { ...event(2, "current", "/omp/current"), agent: { ...event(2, "current", "/omp/current").agent, agent: "omp" } };
  const foreign = (seq: number, id: string, path: string) => ({ ...event(seq, id, path), agent: { ...event(seq, id, path).agent, agent: "opencode" } });
  const f = fixture([page([foreign(1, "old", "/opencode/old"), own, foreign(3, "current", "/opencode/wrong-same-id"), foreign(4, "latest-foreign", "/opencode/latest")], 4), page([], 4, 4)]);
  assert.deepEqual(await f.run(), { nativeSessionId: "current", boundarySeq: 2, highWater: 4, transcriptPath: "/omp/current" });
  assert.deepEqual(f.state.calls, [0, 4]);
  await assert.rejects(fixture([page([foreign(1, "only-old", "/opencode/old")], 1), page([], 1, 1)]).run(), code("identity_unconfirmed"));
});

test("cross CLI candidate starts strictly after its saved cursor and requires an explicit matching CLI", async () => {
  const attributed = (seq: number, cli: string, id: string, path?: string) => ({ ...event(seq, id, path), agent: { ...event(seq, id, path).agent, agent: cli } });
  const f = fixture([page([
    attributed(6, "opencode", "old", "/old"), event(7, "unattributed", "/legacy"),
    attributed(8, "omp", "new", "/new"), attributed(9, "opencode", "new", "/wrong"), attributed(10, "omp", "new"),
  ], 10), page([], 10, 10)]);
  assert.deepEqual(await f.run({ afterSeq: 5, requireExplicitCli: true }), { nativeSessionId: "new", boundarySeq: 8, highWater: 10, transcriptPath: "/new" });
  assert.deepEqual(f.state.calls, [5, 10]);
  await assert.rejects(fixture([page([event(6, "legacy", "/legacy")], 6), page([], 6, 6)]).run({ afterSeq: 5, requireExplicitCli: true }), code("identity_unconfirmed"));
  await assert.rejects(fixture([page([attributed(5, "omp", "already-consumed", "/old")], 5)]).run({ afterSeq: 5, requireExplicitCli: true }), code("source_gap"));
});

test("manual identity scan does not let an unlabelled old event replace an explicitly attributed current candidate", async () => {
  const own = { ...event(1, "current", "/omp/current"), agent: { ...event(1, "current", "/omp/current").agent, agent: "omp" } };
  const f = fixture([page([own, event(2, "old-late", "/opencode/old")], 2), page([], 2, 2)]);
  assert.deepEqual(await f.run(), { nativeSessionId: "current", boundarySeq: 1, highWater: 2, transcriptPath: "/omp/current" });
});


test("unknown events cannot establish or replace native identity even when their CLI label matches", async () => {
  const unknown = { ...event(1, "unexpected", "/unexpected"), agent: { ...event(1, "unexpected", "/unexpected").agent, agent: "omp", event: "future_status_ping" } };
  await assert.rejects(fixture([page([unknown], 1), page([], 1, 1)]).run({ requireExplicitCli: true }), code("identity_unconfirmed"));
  const own = { ...event(1, "current", "/current"), agent: { ...event(1, "current", "/current").agent, agent: "omp" } };
  const later = { ...unknown, sourceSeq: 2 };
  assert.deepEqual(await fixture([page([own, later], 2), page([], 2, 2)]).run(), { nativeSessionId: "current", boundarySeq: 1, highWater: 2, transcriptPath: "/current" });
});
