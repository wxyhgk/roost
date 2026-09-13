import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

export const MAX_PEER_TEXT_BYTES = 15 * 1024;
export const MAX_REQUEST_BYTES = 32 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** @typedef {{env?:NodeJS.ProcessEnv,signal?:AbortSignal,timeoutMs?:number}} PeerClientOptions */
/** Stable application errors; send timeout/abort never asserts that delivery was cancelled. */
export class AgentMessagingError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message); this.name = "AgentMessagingError"; this.code = code;
    /** @type {number|undefined} */ this.status = undefined;
  }
}

/** @param {unknown} value @param {string} name */
function identifier(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value))
    throw new AgentMessagingError("invalid_request", `Invalid ${name}`);
}
/** @param {string} verb @param {unknown} input @returns {Record<string, unknown>} */
function validate(verb, input) {
  if (!["context", "send", "inbox", "outbox"].includes(verb) || !input || typeof input !== "object" || Array.isArray(input))
    throw new AgentMessagingError("invalid_request", "Invalid messaging request");
  const fields = verb === "context" ? [] : ["expectedConversationId", "expectedRunId", ...(verb === "send" ? ["recipientId", "requestId", "text", "inReplyTo"] : ["cursor", "limit"])];
  const value = /** @type {Record<string,unknown>} */ (input);
  if (Object.keys(value).some(key => !fields.includes(key))) throw new AgentMessagingError("invalid_request", "Unknown messaging request field");
  if (verb === "context") return {};
  identifier(value.expectedConversationId, "expectedConversationId"); identifier(value.expectedRunId, "expectedRunId");
  if (verb === "send") {
    identifier(value.recipientId, "recipientId"); identifier(value.requestId, "requestId");
    if (typeof value.text !== "string" || !value.text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value.text) || /[\uD800-\uDFFF]/u.test(value.text))
      throw new AgentMessagingError("invalid_request", "Invalid message text");
    if (Buffer.byteLength(value.text) > MAX_PEER_TEXT_BYTES) throw new AgentMessagingError("too_large", "Message exceeds 15 KiB");
    if (value.inReplyTo !== undefined && value.inReplyTo !== null) identifier(value.inReplyTo, "inReplyTo");
  } else {
    if (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor || value.cursor.length > 2048))
      throw new AgentMessagingError("invalid_request", "Invalid mailbox cursor");
    if (value.limit !== undefined && (!Number.isInteger(value.limit) || /** @type {number} */(value.limit) < 1 || /** @type {number} */(value.limit) > 100))
      throw new AgentMessagingError("invalid_request", "Limit must be between 1 and 100");
  }
  return { ...value };
}

/** Redact both object keys and string values without interpreting tokens as JSON syntax.
 * @param {unknown} value @param {string} token @param {number} [depth] @returns {any}
 */
export function redact(value, token, depth = 0) {
  if (depth > 256) throw new AgentMessagingError("invalid_response", "Agent messaging response is nested too deeply");
  if (typeof value === "string") return token ? value.replaceAll(token, "[redacted]") : value;
  if (Array.isArray(value)) return value.map(item => redact(item, token, depth + 1));
  if (value && typeof value === "object") {
    /** @type {Record<string,unknown>} */ const result = {};
    for (const [key, item] of Object.entries(value)) Object.defineProperty(result, token ? key.replaceAll(token, "[redacted]") : key,
      { value: redact(item, token, depth + 1), enumerable: true, configurable: true, writable: true });
    return result;
  }
  return value;
}

/** Perform exactly one owner IPC request using the current terminal's fixed credentials.
 * This never discovers context, changes identity pins, starts PTYs, or retries.
 * @param {string} verb @param {unknown} input @param {PeerClientOptions} [options] @returns {Promise<any>}
 */
export async function requestPeer(verb, input, { env = process.env, signal, timeoutMs = 5000 } = {}) {
  const value = validate(verb, input);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new AgentMessagingError("invalid_request", "Timeout must be between 1 and 5000 ms");
  const { ROOST_AGENT_SOCKET: socketPath, ROOST_AGENT_TERMINAL: terminalId, ROOST_AGENT_INSTANCE: instanceId, ROOST_AGENT_TOKEN: token } = env;
  if (!socketPath || !terminalId || !instanceId || !token) throw new AgentMessagingError("environment_unavailable", "Agent messaging environment is unavailable in this terminal");
  if (signal?.aborted) throw new AgentMessagingError("aborted", "Request aborted; this does not cancel a previously submitted message");
  const requestId = randomUUID();
  const method = { context: "peerContext", send: "peerSend", inbox: "peerInbox", outbox: "peerOutbox" }[verb];
  const envelope = { terminalId, instanceId, token, ...(verb === "context" ? {} : verb === "send" ? { input: value } : { options: value }) };
  const request = JSON.stringify({ requestId, method, args: [envelope] }) + "\n";
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) throw new AgentMessagingError("too_large", "Agent messaging request exceeds 32 KiB");
  return new Promise((resolve, reject) => {
    /** @type {import('node:net').Socket} */ let socket;
    try { socket = createConnection(socketPath); }
    catch { reject(new AgentMessagingError("connection_failed", "Agent messaging connection failed")); return; }
    let buffer = "", bytes = 0, done = false;
    /** @param {AgentMessagingError|null} error @param {unknown} [result] */
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new AgentMessagingError("aborted", "Request aborted; the daemon may already have saved the message"));
    const timeout = setTimeout(() => finish(new AgentMessagingError("timeout", "Agent messaging request timed out; send outcome is unknown. Keep the same request ID and identity pins when checking or retrying")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.setEncoding("utf8");
    socket.on("connect", () => { if (!done) socket.write(request); });
    socket.on("error", () => finish(new AgentMessagingError("connection_failed", "Agent messaging connection failed")));
    socket.on("close", () => finish(new AgentMessagingError("connection_closed", "Agent messaging connection closed before a reply; send outcome may be unknown")));
    socket.on("data", chunk => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE_BYTES) return finish(new AgentMessagingError("response_too_large", "Agent messaging response exceeds 4 MiB"));
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        /** @type {any} */ let response;
        try { response = JSON.parse(line); } catch { return finish(new AgentMessagingError("invalid_response", "Invalid agent messaging response")); }
        if (!response || response.type !== "reply" || response.requestId !== requestId) continue;
        try {
          if (response.error) {
            const detail = typeof response.error === "object" ? response.error : {};
            const code = typeof (response.code ?? detail.code) === "string" ? response.code ?? detail.code : "daemon_error";
            const message = typeof response.error === "string" ? response.error : typeof detail.message === "string" ? detail.message : "Agent messaging request failed";
            const error = new AgentMessagingError(redact(code, token), redact(message, token));
            const status = response.status ?? detail.status;
            if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
            return finish(error);
          }
          return finish(null, redact(response.result ?? null, token));
        } catch {
          return finish(new AgentMessagingError("invalid_response", "Invalid agent messaging response"));
        }
      }
    });
  });
}
