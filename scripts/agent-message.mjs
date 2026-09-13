#!/usr/bin/env node
import { requestPeer } from "../packages/agent-messaging/src/client.mjs";
const usage = "Usage: agent-message.mjs context | send --from CID --run RUNID --to ID --request-id KEY --text TEXT [--reply-to ID] | inbox|outbox --from CID --run RUNID [--cursor CURSOR] [--limit N]";

async function main() {
  const [verb, ...args] = process.argv.slice(2);
  if (!["context", "send", "inbox", "outbox"].includes(verb)) throw new Error(usage);
  const flags = new Map();
  const allowed = verb === "context" ? [] : ["--from", "--run", ...(verb === "send" ? ["--to", "--request-id", "--text", "--reply-to"] : ["--cursor", "--limit"])];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!allowed.includes(flag) || flags.has(flag) || value === undefined) throw new Error(usage);
    flags.set(flag, value);
  }
  if (verb !== "context" && !["--from", "--run"].every(key => flags.get(key)?.trim())) throw new Error(usage);
  const pin = { expectedConversationId: flags.get("--from"), expectedRunId: flags.get("--run") };
  let input = {};
  if (verb === "send") {
    if (!["--to", "--request-id", "--text"].every(key => flags.get(key)?.trim())) throw new Error(usage);
    if (Buffer.byteLength(flags.get("--text")) > 15 * 1024) throw new Error("Message exceeds 15 KiB");
    input = { ...pin, recipientId: flags.get("--to"), requestId: flags.get("--request-id"), text: flags.get("--text"),
      ...(flags.has("--reply-to") ? { inReplyTo: flags.get("--reply-to") } : {}) };
  } else if (verb !== "context") {
    const limit = flags.has("--limit") ? Number(flags.get("--limit")) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error("Limit must be between 1 and 100");
    input = { ...pin, ...(flags.has("--cursor") ? { cursor: flags.get("--cursor") } : {}), ...(limit === undefined ? {} : { limit }) };
  }
  const result = await requestPeer(verb, input);
  process.stdout.write(JSON.stringify(result ?? null) + "\n");
}

main().catch(error => {
  const token = process.env.ROOST_AGENT_TOKEN;
  const message = error instanceof Error ? error.message : "Agent messaging request failed";
  process.stderr.write((token ? message.replaceAll(token, "[redacted]") : message) + "\n");
  process.exitCode = 1;
});
