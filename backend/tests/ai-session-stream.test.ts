import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createAiSessionBridge } from "@roost/ai-session-bridge";
import { attachAiSessionStream, MAX_AI_STREAM_PENDING_BYTES } from "../src/ai-session-stream.ts";

test("two clients receive independent replay and live events; reconnect resumes and client input is rejected", async t => {
  const bridge = createAiSessionBridge({ maxEvents: 2 });
  bridge.bind({ webSessionId: "s", terminalInstanceId: "i", cliId: "claude", nativeSessionId: "n" });
  const publish = (id: string) => bridge.publish("s", { eventId: id, type: "message", content: id });
  publish("1"); publish("2"); publish("3");
  const server = createServer(); const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => attachAiSessionStream(ws, bridge, "s", Number(new URL(req.url!, "http://localhost").searchParams.get("afterSeq"))));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const clients: WebSocket[] = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); for (const ws of wss.clients) ws.terminate(); wss.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const connect = async (cursor: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/?afterSeq=${cursor}`);
    clients.push(ws);
    const message = await once(ws, "message");
    return { ws, snapshot: JSON.parse(message[0].toString()) };
  };
  const a = await connect(0), b = await connect(2);
  assert.equal(a.snapshot.hasGap, true);
  assert.deepEqual(a.snapshot.events.map((e: { seq: number }) => e.seq), [2, 3]);
  assert.deepEqual(b.snapshot.events.map((e: { seq: number }) => e.seq), [3]);
  const nextA = once(a.ws, "message"), nextB = once(b.ws, "message");
  publish("4");
  for (const message of await Promise.all([nextA, nextB])) assert.equal(JSON.parse(message[0].toString()).seq, 4);
  const closed = once(a.ws, "close"); a.ws.send("input"); assert.equal((await closed)[0], 1008);
  const next = once(b.ws, "message"); publish("5"); assert.equal(JSON.parse((await next)[0].toString()).seq, 5);
  const c = await connect(4);
  assert.deepEqual(c.snapshot.events.map((e: { seq: number }) => e.seq), [5]);
});

test("slow or failing subscribers are detached without stopping healthy deliveries", () => {
  const bridge = createAiSessionBridge();
  bridge.bind({ webSessionId: "s", terminalInstanceId: "i", cliId: "claude", nativeSessionId: "n" });
  class Socket extends EventEmitter {
    OPEN = 1; readyState = 1; bufferedAmount = 0; terminated = false; messages: string[] = [];
    send(data: string, callback: (error?: Error) => void) { this.messages.push(data); callback(); }
    terminate() { this.terminated = true; this.readyState = 3; this.emit("close"); }
  }
  const slow = new Socket(), healthy = new Socket();
  attachAiSessionStream(slow as unknown as WebSocket, bridge, "s", 0);
  attachAiSessionStream(healthy as unknown as WebSocket, bridge, "s", 0);
  slow.bufferedAmount = MAX_AI_STREAM_PENDING_BYTES;
  bridge.publish("s", { eventId: "1", type: "message" });
  assert.equal(slow.terminated, true);
  bridge.publish("s", { eventId: "2", type: "message" });
  assert.equal(slow.messages.length, 1);
  assert.equal(healthy.messages.length, 3);
});
