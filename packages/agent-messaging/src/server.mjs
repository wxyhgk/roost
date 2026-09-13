import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AgentMessagingError, redact, requestPeer } from "./client.mjs";

const identity = z.string().min(1).max(512).refine(value => !!value.trim() && !/[\x00-\x1f\x7f]/.test(value));
const pin = {
  expectedConversationId: identity.describe("Conversation ID captured from agent_context for this operation; never silently refresh it"),
  expectedRunId: identity.describe("Run ID captured with that conversation; identity changes require explicit reconsideration")
};
const schemas = {
  agent_context: z.object({}).strict(),
  agent_send: z.object({ ...pin, recipientId: identity, requestId: identity.describe("Stable logical send ID; reuse only for the same body, recipient and reply relationship"),
    text: z.string().min(1).describe("Plain text, at most 15 KiB UTF-8"), inReplyTo: identity.nullable().optional() }).strict(),
  agent_inbox: z.object({ ...pin, cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  agent_outbox: z.object({ ...pin, cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
};
const descriptions = {
  agent_context: "Read this terminal's current conversation and run IDs. This does not send a message or choose another terminal.",
  agent_send: "Save one message for another conversation using both expected identity IDs. Queued means saved, not received or completed. No automatic retry occurs; a timeout or cancellation may leave the send outcome unknown. Reuse the same requestId and identity pins when checking or retrying the same operation.",
  agent_inbox: "Read this conversation's inbox with both expected identity IDs; never refresh pins automatically after an identity mismatch.",
  agent_outbox: "Read this conversation's outbox with both expected identity IDs; never refresh pins automatically after an identity mismatch."
};

/** @param {Record<string,unknown>} payload @param {boolean} [isError] */
function result(payload, isError = false) {
  return { content: [{ type: /** @type {const} */ ("text"), text: JSON.stringify(payload) }], structuredContent: payload, ...(isError ? { isError: true } : {}) };
}

/** Create an MCP server with immutable terminal credentials and no global session state.
 * @param {import('./client.mjs').PeerClientOptions} [options]
 */
export function createAgentMessagingServer(options = {}) {
  const source = options.env ?? process.env;
  const env = Object.freeze({ ROOST_AGENT_SOCKET: source.ROOST_AGENT_SOCKET, ROOST_AGENT_TERMINAL: source.ROOST_AGENT_TERMINAL,
    ROOST_AGENT_INSTANCE: source.ROOST_AGENT_INSTANCE, ROOST_AGENT_TOKEN: source.ROOST_AGENT_TOKEN });
  const lifecycle = new AbortController();
  const server = new Server({ name: "roost-agent-messaging", version: "0.0.0" }, { capabilities: { tools: {} } });
  let active = 0, initialized = false;
  server.oninitialized = () => { if (server.getClientVersion()) initialized = true; };
  /** @type {import('@modelcontextprotocol/sdk/types.js').Tool[]} */
  const tools = Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[/** @type {keyof typeof descriptions} */(name)],
    inputSchema: /** @type {{type:'object',properties?:Record<string,object>,additionalProperties?:boolean}} */(z.toJSONSchema(schema)),
    annotations: { readOnlyHint: name !== "agent_send" } }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!initialized) return result({ error: { code: "not_initialized", message: "Initialize the MCP connection before calling agent tools" } }, true);
    const name = request.params.name;
    if (!Object.hasOwn(schemas, name)) return result({ error: { code: "unknown_tool", message: "Unknown agent messaging tool" } }, true);
    const schema = schemas[/** @type {keyof typeof schemas} */(name)];
    const parsed = schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return result({ error: { code: "invalid_request", message: "Invalid tool arguments; provide only the documented fields and both identity pins where required" } }, true);
    if (active >= 8) return result({ error: { code: "busy", message: "Too many agent messaging requests are in progress" } }, true);
    active += 1;
    try {
      const signal = AbortSignal.any([lifecycle.signal, extra.signal, ...(options.signal ? [options.signal] : [])]);
      const value = await requestPeer(name.slice("agent_".length), parsed.data, { env, signal, timeoutMs: options.timeoutMs });
      return result(value && typeof value === "object" && !Array.isArray(value) ? value : { result: value });
    } catch (error) {
      const failure = error instanceof AgentMessagingError ? error : new AgentMessagingError("internal_error", "Agent messaging request failed");
      return result({ error: { code: redact(failure.code, env.ROOST_AGENT_TOKEN ?? ""), message: redact(failure.message, env.ROOST_AGENT_TOKEN ?? ""),
        ...(failure.status === undefined ? {} : { status: failure.status }) } }, true);
    } finally { active -= 1; }
  });
  const close = server.close.bind(server);
  server.close = async () => { lifecycle.abort(); await close(); };
  server.onclose = () => lifecycle.abort();
  return server;
}
