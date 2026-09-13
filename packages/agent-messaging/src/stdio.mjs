#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentMessagingServer } from "./server.mjs";

const lifecycle = new AbortController();
const server = createAgentMessagingServer({ signal: lifecycle.signal });
const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 64 * 1024 });
let closing = false;
async function shutdown() {
  if (closing) return; closing = true; lifecycle.abort();
  // A paused inherited pipe can still keep the executable alive. Bound shutdown
  // even when the host stops draining stdout; this never withdraws a saved send.
  const deadline = setTimeout(() => process.exit(process.exitCode ?? 0), 250);
  deadline.unref();
  try { await server.close(); } catch { /* Keep stdout exclusively for protocol messages. */ }
  process.stdin.destroy();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);
process.stdout.once("error", shutdown);
server.onerror = () => { void shutdown(); };

// Install the bound before transport.start() adds stdin listeners; even the first
// already-buffered chunk must pass through it.
const start = transport.start.bind(transport);
const send = transport.send.bind(transport);
/** @type {Set<string|number>} */ const pending = new Set();
transport.start = async () => {
  const receive = transport.onmessage;
  transport.onmessage = message => {
    if (closing) return;
    if ("method" in message && message.method === "notifications/cancelled") {
      const requestId = message.params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") pending.delete(requestId);
    }
    if ("method" in message && "id" in message) {
      if (pending.size >= 16 || pending.has(message.id)) { void shutdown(); return; }
      pending.add(message.id);
    }
    receive?.(message);
  };
  await start();
};
transport.send = async message => {
  await send(message);
  if (!("method" in message) && "id" in message && message.id !== undefined) pending.delete(message.id);
};
try {
  await server.connect(transport);
} catch {
  process.exitCode = 1;
  await shutdown();
}
