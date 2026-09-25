# Agent messaging tools

Workspace Agent 通讯的本地 MCP stdio 入口。它复用 daemon 的持久信箱与身份核验，不创建模型进程、不持有 PTY、不直接打开 SQLite。

## 启动

在本应用创建的终端中，下面是 Claude 的单次启动配置示例。请将两个绝对路径替换为本机 Node 与本仓库实际路径；`env` 中保持变量引用，不填入实际凭证：

```json
{
  "mcpServers": {
    "workspace-messages": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/roost/packages/agent-messaging/src/stdio.mjs"],
      "env": {
        "ROOST_AGENT_SOCKET": "${ROOST_AGENT_SOCKET}",
        "ROOST_AGENT_TERMINAL": "${ROOST_AGENT_TERMINAL}",
        "ROOST_AGENT_INSTANCE": "${ROOST_AGENT_INSTANCE}",
        "ROOST_AGENT_TOKEN": "${ROOST_AGENT_TOKEN}"
      }
    }
  }
}
```

Claude 支持通过单次启动参数 `--mcp-config /absolute/path/to/config.json` 加载这类配置，并在 `env` 中展开 `${VAR}`。配置格式与环境传递属于具体 CLI；其他客户端须按自己的 MCP 配置格式填写 command/args，并显式传递相同四个环境变量。不要假设客户端会继承全部父进程环境，也不要将 Claude 的变量展开语法照搬到其他客户端。包协议测试不等于所有 CLI 的加载测试。

服务器从启动环境读取 `ROOST_AGENT_SOCKET`、`ROOST_AGENT_TERMINAL`、`ROOST_AGENT_INSTANCE`、`ROOST_AGENT_TOKEN`。不将实际值抄入 MCP JSON、工具参数或提示词。独立于本应用启动的普通终端没有这些身份信息，工具会明确报错。已有的 `scripts/agent-message.mjs` 命令仍可使用。

## 工具

| 名称 | 参数 | 用途 |
| --- | --- | --- |
| `agent_context` | `{}` | 读取当前可信 conversationId/runId |
| `agent_peers` | expectedConversationId、expectedRunId | 列出此刻收得到信的其他对话，给出 `agent_send` 要的 recipientId |
| `agent_send` | expectedConversationId、expectedRunId、recipientId、requestId、text；可选 inReplyTo | 保存一封发往明确对话的信 |
| `agent_inbox` | expectedConversationId、expectedRunId；可选 cursor、limit | 分页查询自己的收件箱 |
| `agent_outbox` | expectedConversationId、expectedRunId；可选 cursor、limit | 分页查询自己的发件箱与投递状态 |

先读取 context，再将返回的两个 ID 显式传给其他工具。对话或运行已经切换时，旧请求应失败；不能为执行旧任务而自动读取新身份重发。目标使用永久 conversation ID，不用终端标题或文件夹名猜测。

`agent_peers` 是发信链的第一环。在它之前，`agent_context` 只给得出自己的 ID，于是没有人能**先**开口——只能等别人来信再回，而第一封信必须由人在网页上点。它返回的每一项带
`recipientId`、`title`、`cwd`、`cli`，以及 `deliverable` 与 `reason`。

它用的是投递泵（`terminal-daemon/src/peer-delivery.ts` 的 `pump()`）判断收件人的**同一套条件**，所以：不在列表里的对话此刻根本不可寻址；在列表里但 `deliverable` 为 false 的，`reason` 就是泵会写进投递记录的那个字符串（`busy`、`command_pending`、`unsupported_cli` 等），界面上看到的是同一句话。列表里不含调用者自己。

列表是选目标的依据，不是身份来源：仍然按 `recipientId` 发，不要用 `title` 或 `cwd` 去猜。

同一次发信重试保持相同 requestId 与内容。取消 MCP 请求、超时或连接断开只能停止等待，不能保证已保存的信被撤销；通过信箱核对结果。工具不会自动重发。

正文最大 15 KiB，分页 limit 为 1–100。参数不接受 token、socket、senderKind 或其他未声明字段。返回中 queued 表示已进入平台信箱；accepted 仍按现有原生接收证据认定，并不表示模型接受任务或已经回信。

## 兼容与验收边界

锁定 `@modelcontextprotocol/sdk` 1.30.0 与 `zod` 4.5.4，使用 v1 的 initialize/JSONL stdio 兼容接口。官方另有 v2 SDK；本包没有宣称实现 v2 的全部协议能力。

运行 `npm test --workspace @roost/agent-messaging` 和 `npm run typecheck --workspace @roost/agent-messaging`。测试范围与真实模型协作状态见 [实施记录](../../tasks/conversation-database/14-mcp-tools-implementation.md)。本包不自动安装到日常 CLI，不启用 Claude Channels，不保证工具加载后模型一定自动调用。

真实 Claude Code 2.1.266 / claude-sonnet-5 在隔离配置下已完成一次 MCP A→B→A 往返、原生回执与 HTTP/WS 同步；浏览器及其他 CLI 未据此验收。受控 TUI 输入不能将灰色文字直接当作空白；启用 GUI 发送时，新启动器在适用的 Claude 子进程关闭 prompt suggestions，避免建议文字阻塞草稿保护。已有 CLI 不会热更新此环境。失败与修复见 [前轮记录](../../tasks/conversation-database/15-mcp-live-implementation.md)，最新结果见 [修复后验收](../../tasks/conversation-database/16-mcp-postfix-validation.md)。

参考：[MCP v1 服务端](https://ts.sdk.modelcontextprotocol.io/server)、[Claude MCP 配置](https://code.claude.com/docs/en/mcp)。
