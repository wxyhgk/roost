import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentEventScanner, CLI_AGENT_SENTINEL } from "../src/agent-events.ts";

const BEL = "\x07";
const ST = "\x1b\\";
const seq = (json: string, terminator = BEL) =>
  `\x1b]777;notify;${CLI_AGENT_SENTINEL};${json}${terminator}`;
const START = JSON.stringify({ event: "session_start", agent: "omp", session_id: "s1", cwd: "/tmp" });
const ASK = JSON.stringify({ event: "permission_request", agent: "omp", session_id: "s1" });

test("解析真实 agent 事件，未知字段与未知事件都不丢弃", () => {
  const s = createAgentEventScanner();
  const [start] = s.push(seq(START));
  assert.equal(start.event, "session_start");
  assert.equal(start.agent, "omp");
  assert.equal(start.sessionId, "s1", "session_id 转成驼峰");
  assert.equal(start.cwd, "/tmp");

  // 协议会加新事件，旧宿主不该把它们当垃圾扔掉。
  const [future] = s.push(seq(JSON.stringify({ event: "brand_new", agent: "omp" })));
  assert.equal(future.event, "brand_new");
});

test("PTY 的读边界切开转义序列时仍能还原", () => {
  const whole = "before" + seq(START) + "after";
  // 逐字节喂：任何一个切点都不能丢事件。
  const s = createAgentEventScanner();
  const events = [];
  for (const ch of whole) events.push(...s.push(ch));
  assert.equal(events.length, 1, "逐字节喂入应当恰好还原一条");
  assert.equal(events[0].event, "session_start");

  // 再穷举所有两段切法，确保回溯长度足够。
  for (let i = 0; i <= whole.length; i++) {
    const two = createAgentEventScanner();
    const got = [...two.push(whole.slice(0, i)), ...two.push(whole.slice(i))];
    assert.equal(got.length, 1, `在第 ${i} 字节切开时丢了事件`);
  }
});

test("一个 chunk 里的多条事件按序取出，ST 与 BEL 两种终止符都认", () => {
  const s = createAgentEventScanner();
  const got = s.push(seq(START) + "noise" + seq(ASK, ST) + "tail");
  assert.deepEqual(got.map(e => e.event), ["session_start", "permission_request"]);
});

test("JSON 里的分号不会被当成字段分隔", () => {
  const s = createAgentEventScanner();
  const [e] = s.push(seq(JSON.stringify({ event: "prompt_submit", query: "a;b;c" })));
  assert.equal(e.query, "a;b;c");
});

test("非本协议的 OSC 777 与坏 JSON 一律忽略，且不影响后续解析", () => {
  const s = createAgentEventScanner();
  assert.deepEqual(s.push("\x1b]777;notify;other://thing;{}" + BEL), [], "别人的 OSC 777 不归我们管");
  assert.deepEqual(s.push(seq("{not json")), [], "坏 JSON 丢弃而不是抛错");
  assert.deepEqual(s.push(seq(JSON.stringify({ agent: "omp" }))), [], "缺 event 字段的不算事件");
  assert.deepEqual(s.push(seq(START)).map(e => e.event), ["session_start"], "坏数据之后仍能继续解析");
});

test("未终止的序列不会无限占用内存", () => {
  const s = createAgentEventScanner();
  // 一个坏程序发了起始标记就再也不收尾。
  assert.deepEqual(s.push("\x1b]777;" + "x".repeat(200_000)), []);
  // 缓冲被放弃后，后续真事件仍然解析得出来。
  assert.deepEqual(s.push(seq(START)).map(e => e.event), ["session_start"]);
});

test("普通输出不驻留缓冲", () => {
  const s = createAgentEventScanner();
  assert.deepEqual(s.push("ls -la\r\n"), []);
  assert.deepEqual(s.push("total 0\r\n"), []);
  // 之后的完整序列不受影响。
  assert.deepEqual(s.push(seq(ASK)).map(e => e.event), ["permission_request"]);
});

test("展示用字段被透传，tool_input 只取可展示的那一项", () => {
  const s = createAgentEventScanner();
  const [ask] = s.push(seq(JSON.stringify({
    event: "permission_request", agent: "omp", summary: "Wants to run Bash: rm -rf /tmp",
    tool_name: "Bash", tool_input: { command: "rm -rf /tmp", file_path: "/tmp", extra: { nested: 1 } },
  })));
  assert.equal(ask.summary, "Wants to run Bash: rm -rf /tmp");
  assert.equal(ask.toolName, "Bash");
  assert.equal(ask.toolInputPreview, "rm -rf /tmp", "command 优先于 file_path");

  // 写文件类工具没有 command，退到 file_path。
  const [write] = s.push(seq(JSON.stringify({
    event: "permission_request", tool_name: "Write", tool_input: { file_path: "/etc/hosts" },
  })));
  assert.equal(write.toolInputPreview, "/etc/hosts");

  const [fail] = s.push(seq(JSON.stringify({ event: "stop_failure", error_type: "timeout" })));
  assert.equal(fail.errorType, "timeout");
});

test("展示用字段缺失或类型不对时不报错，也不泄漏整包 tool_input", () => {
  const s = createAgentEventScanner();
  // 老 agent 一个新字段都不发。
  const [bare] = s.push(seq(START));
  assert.equal(bare.summary, undefined);
  assert.equal(bare.toolName, undefined);
  assert.equal(bare.toolInputPreview, undefined);

  // tool_input 的形状由工具自己定，什么都可能来；非字符串一律不展示。
  for (const toolInput of [null, "a string", 42, [1, 2], { command: 42 }, { command: { nested: true } }]) {
    const [event] = s.push(seq(JSON.stringify({ event: "permission_request", tool_input: toolInput })));
    assert.equal(event.toolInputPreview, undefined, JSON.stringify(toolInput));
  }
  const [event] = s.push(seq(JSON.stringify({ event: "permission_request", summary: 7, tool_name: {} })));
  assert.equal(event.summary, undefined);
  assert.equal(event.toolName, undefined);
});

test("transcript_path is preserved as a string without coercing invalid values", () => {
  const scanner=createAgentEventScanner();
  const wrap=(value:unknown)=>"\x1b]777;notify;warp://cli-agent;"+JSON.stringify({event:"stop",transcript_path:value})+"\x07";
  assert.equal(scanner.push(wrap("/tmp/native.jsonl"))[0].transcriptPath,"/tmp/native.jsonl");
  assert.equal(scanner.push(wrap({path:"not a string"}))[0].transcriptPath,undefined);
});
