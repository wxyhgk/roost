# Grok Build 后端适配（2026-09-09）

## 已验证与实现

这里指 xAI 官方 Grok Build，本机 `grok --version` 是 **1.0.13 (5e9a58528b76)**，不是 superagent-ai 同名 npm CLI。

已实现 `packages/ai-transcript/src/grok.ts`：

- `readGrokTranscript(path, nativeId, previous?)` 读取官方 `updates.jsonl`，返回现有 checkpoint/items/details/reset/bytesRead 契约。
- `discoverGrokTranscript(nativeId, roots)` 仅在调用者授权的 sessions 根下寻找 `<encoded cwd>/<nativeId>/updates.jsonl`，不猜最新会话。最多检查 10000 个目录项，多匹配拒绝。
- 每次增量读 256 KiB；跨 UTF-8 和半条 JSON 的字节持久在 checkpoint；单行上限 1 MiB；正文预览 64 KiB，详情 256 KiB。换文件、重写、截断会 reset。
- 首行及每条记录校验 `params.sessionId`，使用 `params._meta.eventId` 作稳定原生事件 ID。读到其它会话立即拒绝。
- 支持 ACP user/assistant/thought 文本片段、tool_call/tool_call_update 的文本及输入输出；未知记录标记 partial。这里的粒度是原生记录片段，**不是伪造的完整 assistant 回合**。
- 跳过已知非正文更新；不把 `chat_history.jsonl` 中的系统提示词、自动注入上下文误标成用户聊天。

接入时通过现有 transcript registry 注册 `grok` / `file` / `recorded_supported_entries`（通用 reader 注册），对外 sync coverage 明确 `recorded_chunks`，自动身份绑定必须来自真实终端证据。本 reader 不会为了读取记录启动第二个 agent。GUI 发送能力仍应为不支持，不能因 reader 注册就开启。

## 证据来源

官方文档：

- [CLI reference](https://docs.x.ai/build/cli/reference)：裸 `grok` 为 TUI，`agent stdio` 为 ACP。
- [Headless & scripting](https://docs.x.ai/build/cli/headless-scripting)：ACP JSON-RPC，正文通过 session/update 通知到达。
- [Sessions](https://docs.x.ai/build/features/sessions)：TUI、headless、ACP 会话都保存到 sessions 目录。
- [Hooks](https://docs.x.ai/build/features/hooks)：事件输入为 camelCase `hookEventName`、`sessionId`、`cwd`、`workspaceRoot`。
- [Plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces)：插件加载来源与 hook 环境。

本机隔离验证：新建临时 `GROK_HOME`，假 API key，`--xai-api-base-url http://127.0.0.1:9`，`agent --no-leader stdio`，发送 initialize/session-new 和固定合成文本。没有调用真实模型，没有访问用户已有聊天。该 CLI 仍发现 HOME 下通用 skills/MCP；未来完全沙箱实验还应同时隔离 HOME，不能把 GROK_HOME 当作所有配置来源的隔离边界。此次只读取新生成会话的结构，未保存系统注入内容到仓库。

实测输出：

```json
{"timestamp":1788935704,"method":"session/update","params":{"sessionId":"<native-id>","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"ROOST_SYNTHETIC_TEST"},"_meta":{"modelId":"grok-4.6","promptIndex":0}},"_meta":{"eventId":"<native-id>-2","agentTimestampMs":1788935703703}}}
```

同会话目录还有 summary.json (`info.id`, `info.cwd`, `chat_format_version:1`)、chat_history.jsonl、events.jsonl。当前选择 updates.jsonl，因其原生 session 身份、事件 ID 和 ACP 内容明确。

## 为什么还没有开启双向发送

本机 `grok agent --help` 显示 `--leader` 支持多个客户端共享 backend，并提供 `--leader-socket`；裸 TUI 也有 `--leader-socket`。这比创建另一条 headless 会话更接近目标，但“同 backend”不等于“同一会话且 TUI 草稿为空”。

Happier `apps/cli/src/backends/grok/acp/launch.ts` 使用 `--no-auto-update agent stdio`，backend.ts 使用 ACP prompt、permission 与 x.ai 扩展。它证明 ACP 可集成，不证明已经打开的裸 TUI 可无缝双写。

另一个已实测的版本差异：官网 plugins 文档列了 `--plugin-dir`，但 **本机 1.0.13 裸 TUI 拒绝该参数**；它只在 `grok agent --plugin-dir` 可用。因此不能照搬 Claude 的启动 wrapper，否则用户的 grok 会直接启动失败。二进制自带文档也说明 GROK_CONFIG overlay 只接受有限软设置，不能注入 plugins/hooks discovery。

后续先做隔离 leader 的 TUI + ACP 双客户端试验，核对 agentInstanceId、native sessionId、session/load 的附着语义和双方更新；确认 GUI 发送后原 TUI 同步显示，并明确 TUI 草稿、权限弹窗、正在生成时的控制规则。未完成前不提供可发送 capability，也不使用第二个独立 agent 冒充同步。

## 验证

`node --import tsx --test packages/ai-transcript/tests/grok.test.ts`：3 项通过，覆盖稳定 ID、工具输出、UTF-8 跨批、重复读取、跨会话拒绝、发现歧义、未知格式、重写及字节上限。

真实 CLI 的隔离测试只验证了协议初始化、用户片段落盘和 reader 可读取；助手/工具形状由 ACP 对应 fixture 验证，尚未用真实模型做 TUI/GUI 端到端验收。

兼容边界：只有 `method: session/update` 的标准 ACP 内容生成正文；`_x.ai/session/update` 私有扩展目前计入 skipped/partial，不把 retry_state 当聊天。支持的 sessionUpdate 为 user_message_chunk、agent_message_chunk、agent_thought_chunk、tool_call、tool_call_update；已知 plan/usage/mode 等不生成正文。缺少 native eventId 的内容不生成假 ID。后续需单独实现有证据的 turn 组装。

真实合成 fixture 烟测已通过：读取 1908 bytes，得到恰好 1 条固定用户文本，4 条私有 retry_state 被跳过并标记 partial；standalone TypeScript 检查（包含 node types）通过。
