/**
 * CLI agent 结构化事件（OSC 777）。
 *
 * agent 主动上报自己的状态，而不是由终端去猜。这条路是必要的：仅凭输出流无法区分
 * 「正在安静地算」和「弹了个确认框在等你」——两者都表现为不再产生输出。
 *
 * 线格式：ESC ] 777 ; notify ; warp://cli-agent ; <JSON> BEL
 * （终止符也接受 ST，即 ESC \)
 *
 * 协议与事件词表沿用 Warp 定义的同名约定，这样已经在发这套事件的 CLI（omp 原生，
 * Claude Code / Codex / Gemini / OpenCode 经插件）无需任何改动即可被识别。
 */

export const CLI_AGENT_SENTINEL = "warp://cli-agent";
export const CLI_AGENT_PROTOCOL_VERSION = 1;

/** 宿主通过这两个环境变量告知 agent「我认这套协议」，agent 检测到才发。 */
export const CLI_AGENT_PROTOCOL_VERSION_ENV = "WARP_CLI_AGENT_PROTOCOL_VERSION";
export const CLI_AGENT_CLIENT_VERSION_ENV = "WARP_CLIENT_VERSION";

export type AgentEventType =
  | "session_start" | "prompt_submit" | "tool_complete"
  | "stop" | "stop_failure"
  | "permission_request" | "permission_replied" | "question_asked"
  | "idle_prompt";

export type AgentEvent = {
  /** 未知事件保留原字符串：协议会加新事件，旧宿主不该把它们丢掉。 */
  event: AgentEventType | string;
  agent?: string;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  project?: string;
  query?: string;
  response?: string;
  pluginVersion?: string;
  /** 协议已经拼好的、给人看的整句，如 "Wants to run Bash: rm -rf /tmp"。展示时首选它。 */
  summary?: string;
  /** 工具名，如 Bash / Write。 */
  toolName?: string;
  /** 工具入参里唯一适合直接展示的那一项：命令行，或被操作的文件路径。 */
  toolInputPreview?: string;
  /** stop_failure 的失败分类。 */
  errorType?: string;
};

/** 单条序列的体积上限。超过即放弃缓冲，避免坏程序把内存撑爆。 */
const MAX_SEQUENCE_LENGTH = 64 * 1024;
const START = "\x1b]777;";
const BEL = "\x07";
const ST = "\x1b\\";

function toEvent(json: string): AgentEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.event !== "string" || !value.event) return null;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  // tool_input 是任意形状的工具入参，整包既不适合展示也不该原样外泄；
  // 只取其中唯一有展示价值的那一项，形状与含义都对齐 Warp 的同名派生。
  const toolInput = value.tool_input;
  const previewOf = (key: string) => {
    if (!toolInput || typeof toolInput !== "object") return undefined;
    const found = (toolInput as Record<string, unknown>)[key];
    return typeof found === "string" ? found : undefined;
  };
  return {
    event: value.event,
    agent: text("agent"),
    sessionId: text("session_id"),
    transcriptPath: text("transcript_path"),
    cwd: text("cwd"),
    project: text("project"),
    query: text("query"),
    response: text("response"),
    pluginVersion: text("plugin_version"),
    summary: text("summary"),
    toolName: text("tool_name"),
    toolInputPreview: previewOf("command") ?? previewOf("file_path"),
    errorType: text("error_type"),
  };
}

/**
 * 有状态扫描器：PTY 的读边界会把转义序列切成两半，所以必须跨 chunk 缓冲。
 * 只保留可能属于未完成序列的部分，正常输出不驻留内存。
 */
export function createAgentEventScanner() {
  let pending = "";
  return {
    push(chunk: string): AgentEvent[] {
      const events: AgentEvent[] = [];
      let buffer = pending + chunk;
      pending = "";
      for (;;) {
        const start = buffer.indexOf(START);
        if (start < 0) break;
        const body = buffer.slice(start + START.length);
        const bel = body.indexOf(BEL);
        const st = body.indexOf(ST);
        const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
        if (end < 0) {
          // 序列还没收完：留着等下一个 chunk，除非它已经长得不像话。
          if (body.length <= MAX_SEQUENCE_LENGTH) pending = buffer.slice(start);
          return events;
        }
        const payload = body.slice(0, end);
        buffer = body.slice(end + (end === bel ? BEL.length : ST.length));
        // notify ; <sentinel> ; <JSON>——JSON 里可能有分号，所以只切前两个。
        const first = payload.indexOf(";");
        const second = first < 0 ? -1 : payload.indexOf(";", first + 1);
        if (first < 0 || second < 0) continue;
        if (payload.slice(first + 1, second) !== CLI_AGENT_SENTINEL) continue;
        const event = toEvent(payload.slice(second + 1));
        if (event) events.push(event);
      }
      // 序列开头本身也可能被切开（例如 chunk 末尾正好是 ESC ] 7）。
      // 只回溯不足一个起始标记的长度，正常输出不会因此驻留。
      const keep = Math.min(buffer.length, START.length - 1);
      const tail = buffer.slice(buffer.length - keep);
      for (let i = 0; i < tail.length; i++) {
        if (START.startsWith(tail.slice(i))) {
          pending = tail.slice(i);
          break;
        }
      }
      return events;
    },
  };
}
