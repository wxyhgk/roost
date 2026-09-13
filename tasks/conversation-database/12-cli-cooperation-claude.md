# Claude Code 协作入口核查

核查日期：2026-09-09。范围：本机 CLI 帮助、已安装可执行文件的静态标识、官方公开文档。没有调用模型、连接日常会话 socket、读取凭证或私人对话，也没有安装插件、改用户配置。

## 结论

Claude 现在已有适用于**独立会话**的原生通讯功能，不能再笼统说“只有 agent teams 内部邮箱”。本机 2.1.266 包含相应实现标识。官方也明确讨论脚本和 hook 向会话 socket 投递；但是本轮查到的官方页面没有给出完整消息帧、确认帧及原生消息 ID 的稳定契约。**功能公开存在，不等于我们的 durable delivery 已经能无歧义接入。**

建议先核验原生 inbox 的消息及回执契约，暂不将现有 writer 改成直接写 socket。普通 MCP stdio 适合作为明确的 Agent 发信工具；它不能单独唤醒另一条闲置会话。Channels 是公开的入站推送协议候选，但没有内建处理确认，仍需要我们自己的消息状态与回执设计。

## 1. 本机证据

| 项目 | 已确认内容 | 证据边界 |
| --- | --- | --- |
| 执行版本 | `claude --version` 为 `2.1.266 (Claude Code)` | 本机版本，不代表所有用户 |
| 安装形式 | `~/.local/bin/claude` 链接到 `~/.local/share/claude/versions/2.1.266`，Mach-O arm64 可执行文件 | 没有将非官方还原源码当作上游源码 |
| CLI 参数 | `--mcp-config`、`--strict-mcp-config`、`--allowedTools`、`--plugin-dir` 在帮助中 | 参数存在，不证明某个工具获批或模型已调用 |
| stdio 接入 | `claude mcp add --help` 明确支持 stdio 子进程 | 本轮仅 help，没有执行 add |
| 原生协作标识 | 二进制存在 `ListAgents`、`SendMessage`、`CLAUDE_CODE_MESSAGING_SOCKET`、`crossSessionInbound`、`msgV`、`msg_id`、`peer_message_status` | 字符串存在不能还原完整协议，也不能证明本次会话启用 |
| Channels 标识 | 存在 `--channels`、开发 channel 参数、`notifications/claude/channel` | 功能仍受实际认证、配置与启动条件限制 |

`--teammate-mode` 不出现在本机帮助中，即使仅为 help 设置实验开关也是如此；官方文档明确它是隐藏的实验参数。因此不能以 help 没列出来断言功能不存在。

## 2. 三类入口应分别判断

### 独立会话通讯与原生 inbox

官方公开 `ListAgents` / `SendMessage`，适用于用户自行启动的独立会话。消息可以进入现有会话；接收侧有接收、暂存和拒绝规则。macOS/Linux 的基础版本门槛是 2.1.224，同机全 provider 支持从 2.1.248 起。官方公开 socket/token 环境变量以及连接首行认证，并说明脚本/hook 可向本会话投递。[官方说明](https://code.claude.com/docs/en/cross-session-messaging)

本轮未找到官方定义的完整消息 payload、ACK schema、`msg_id` 与 transcript UUID 的对应及重连幂等保证。网页中的 auth 示例只定义连接认证，不能推导业务帧。定向搜索无结果也不证明其他官方位置一定没有；这仍是待补证据。

对我们设计的推论：

- 运行时 socket 地址只能附属于 run，不能替代永久 conversation ID。
- 本会话导出的 token 不应被复制成其他会话的身份。后台代投递不能伪装为原生 Claude sender，也不能冒充用户批准。
- 如果使用原生 `SendMessage` 从 A 直接发 B，而不经过我们的 ledger，需要明确导入、去重与回执映射；不能默认为已有 `peer_deliveries` 已记录。
- 原生 `msg_id` 是否由客户端提供、是否写入持久 transcript、确认代表排队还是处理，必须逐项核验后才能复用 `accepted` 语义。
- 不扫描日常 socket 猜目标；只使用测试启动流程自行取得的准确 run/nativeSession 对应元数据。

### Agent teams

这是 Claude 管理的团队生命周期，和用户已经打开的 A/B/C 独立终端不同。官方说明它仍是实验能力，有恢复及团队归属限制；较新版本已改变团队创建方式，旧教程中的手工 TeamCreate/TeamDelete 与配置文件做法不可直接套用。[官方说明](https://code.claude.com/docs/en/agent-teams)

我们的选择：不手工写团队 inbox/config，不让 teams 另起一组执行器来冒充现有 A/B/C；它可以作为后续团队功能的参考，不作为这次数据库通讯的捷径。

### MCP stdio 与 Channels

普通 MCP 能让现有 Claude 会话调用我们明确暴露的工具，stdio server 是 CLI 子进程，不必另开模型进程。MCP 配置支持单次启动传入，工具权限可单独控制。[MCP 官方说明](https://code.claude.com/docs/en/mcp)

Channels 则在这个连接上增加外部事件入站；需要其专属能力、启动启用及认证/组织条件。它明确针对运行中的原会话。普通 MCP 工具服务器不能因为会发 JSON-RPC notification 就自动具有 channel 语义。[Channels 概览](https://code.claude.com/docs/en/channels)

公开 channel 协议为 `experimental['claude/channel']` capability，发送 `notifications/claude/channel`，包含 `content` 与可选 `meta`。官方明确：发送 Promise 完成只证明写入 transport，没有客户端处理 ACK；未正确启用时甚至可能静默丢弃。需要确认时，应由 reply/status 工具回报。[Channels 协议](https://code.claude.com/docs/en/channels-reference)

对我们设计的推论：channel 写入只能进入 `dispatching`，不能直接标记 `accepted`。若改为模型调用 `ack_message`，那是**模型工具回执**，必须单独说明证据含义，不能伪装成现有 transcript 接收证明。重启后也不能因为未见 ACK 就自动重发。

## 3. 与 MCP TypeScript SDK v2 的关系

官方 SDK v2 将服务端拆为 `@modelcontextprotocol/server`，stdio 从 `@modelcontextprotocol/server/stdio` 导入；低层 Server 与高层 McpServer 均存在，通知仍有协议版本与 capability 边界。[官方迁移文档](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)

Claude Channels 示例使用 v1 导入路径，不能照抄成 v2 后就认为兼容完成。若选 v2：

1. 用实际发布版本的低层 Server/stdio transport 验证 initialize、tools/list、tools/call。
2. 对自定义 `notifications/claude/channel` 做实际客户端契约测试，确认实验 capability 和自定义 notification 没有被新协议通知路由丢弃。
3. 记录客户端协商协议版本，不把最新版协议订阅能力强加给旧客户端。
4. SDK 对写管道成功的承诺不会升级成 Claude 模型已经处理成功；业务回执继续由我们负责。

没有在本轮安装或编写 SDK 包装。版本选择应使用锁定发布版本及兼容测试，不从 GitHub main 的说明直接推断当前 npm 包行为。

## 4. 最小推进路径

先做有界的 **Claude 原生 inbox 契约探针**，只在自行创建的独立会话中运行：

1. 从本次 SessionStart/hook 精确取得 socket 是否可用及 native ID，关联当前 terminal instance/run；凭证仅在进程内使用。
2. 找到可核验的消息 frame、确认 frame、ID 对应与拒绝/暂存行为；若只有静态字符串或第三方猜测，记录为未确认。
3. 先验证非模型的连接/协议边界，再用一条明确授权的消息确认原生 transcript；没有证据就不打开生产发送。
4. 如原生协议无法提供可维护的确认契约，转为独立的 MCP stdio 工具候选与公开 channel 入站候选，分别验收，不一次替换整个投递层。

MCP 工具候选仅需 `context`、`send_message`、`inbox`、`outbox`，复用已实现 daemon IPC 与 ledger，不直接操作 SQLite，不开另一个 PTY writer。`send_message` 与读信工具保留 expectedConversationId/expectedRunId 双 pin；不能为简化工具参数而重新引入延迟 A 请求被归属 B 的问题。

## 5. 验收必须分层

| 层次 | 能证明什么 | 不能顺带宣称什么 |
| --- | --- | --- |
| 功能出现 | 原生工具/MCP 工具在该会话中可用 | 模型愿意调用 |
| 工具调用成功 | 本次请求经指定工具进入 ledger | 对端 CLI 已接收 |
| 原生接收证据 | 消息确实进入准确 nativeSession | 对端已执行任务 |
| 模型动作/回复 | 本次任务实际产生对应输出 | 后续任意消息都会自动回复 |
| 回程入库与 GUI 同步 | 本次 A→B→A 正确映射、刷新与去重 | 通用跨 CLI 协作已经完成 |

因此不能用重写来信措辞、隐藏来源或强迫回复，替代“CLI 支持的协作入口”和“模型对真实任务的处理”两项验证。

## 本轮交付

只完成研究与方案记录。没有新增原生 writer、MCP server 或 channel，没有更改既有发送 flag、用户配置或日常服务。
