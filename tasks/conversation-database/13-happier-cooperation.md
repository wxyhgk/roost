# Happier 的跨会话通讯、权限与同一终端写入

调研日期：2026-09-09。对象为本地 `research/third-party/happier`，分支 `dev`，commit **`d06e287b42e7b73a48159c21731d33d95e966801`**，来源 [happier-dev/happier](https://github.com/happier-dev/happier/tree/d06e287b42e7b73a48159c21731d33d95e966801)。工作树只读检查为干净；没有拉取更新，所以结论仅针对该固定快照，不宣称是线上最新版本。

已阅读根及 `apps/cli/AGENTS.md`。本轮只读源码并写本文件，没有启动 Happier、调用模型、修改配置、执行其测试或操作日常终端。当前项目 G3 结果仍以 [真实测试报告](verification/g3-tests.md) 为准，不能用第三方源码代替实测。

## 1. 结论

Happier 值得借鉴的不是“让模型一定听其他 Agent 的话”，而是下面三层明确的接口：

1. 会话内部提供可发现的 MCP action tool，将发消息、查询、审批表达成结构化调用。
2. 消息先进入目标会话的持久输入队列，再由目标运行时处理；“入队”“原生收到”“该轮结束”分开判断。
3. Claude unified terminal 路径确实把 GUI 输入交给同一 terminal host，并观察 hook/transcript 的接收证据；另有 headless SDK 和子执行器路径，不能混为一种架构。

**没有在所核验链路中发现能保证 Agent 执行来信任务的机制。** MCP 可以减少调用 shell 脚本的歧义，正式权限请求可以让用户针对工具调用作决定，但二者都不能把已经发生的模型拒绝等同于缺少数据库字段，也不能据此宣布我们 G3 已解决。

## 2. 跨 session 发消息的实际调用链

```text
会话 Agent 的 session_message_send MCP tool
  → action executor：调用表面、启用规则、审批、权限上限
  → CLI action dependencies：认证上下文
  → sendSessionMessage：精确目标 / localId / 入队
  → 目标已有运行时被唤醒，消费自己的 Pending 队列
  → 该 provider 的输入路径及接收证据
```

### 2.1 工具注册与调用者来源

- action `session.message.send` 映射 MCP 名称 `session_message_send`，参数包括目标 session、message、可选请求动作及模式；会话 Agent、外部 MCP、CLI 等表面共用 action 定义。[actionSpecs.ts:2250](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/packages/protocol/src/actions/actionSpecs.ts#L2250)
- 会话内 MCP 构造时绑定 `client.sessionId`，并明确使用 `session_agent` 表面，读取实时 action settings 与调用者 permission mode；不是拿模型随意提交的 sender 字段作为身份。[createHappierMcpServer.ts:64](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/mcp/createHappierMcpServer.ts#L64)
- MCP 调用产生带 session/tool-call 来源的 approval origin，再进入统一 dispatcher。工具是否可见和执行时是否启用都经过策略。[registerHappierMcpBuiltInTools.ts:20](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/mcp/server/registerHappierMcpBuiltInTools.ts#L20)
- `session_agent` 发消息时会检查要求的 permission mode，不能通过给目标设置更宽松模式来绕过调用者上限；有认证 credentials 才能走跨 session 发送服务。[actionExecutor.ts:2223](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/packages/protocol/src/actions/actionExecutor.ts#L2223)、[createCliActionDeps.ts:1621](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/session/actions/createCliActionDeps.ts#L1621)

注意两个不同能力：同一 MCP bridge 里的 `execution.run.*` 被限制在其自身 session，不能因为 `session_message_send` 可跨 session 就推导所有工具都能跨 session。[createHappierMcpServer.ts:131](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/mcp/createHappierMcpServer.ts#L131)

### 2.2 先保存，再唤醒；入队不冒充接收

`sendSessionMessage` 解析 session 目标，使用 `localId` 入持久 Pending 队列；已有 active runtime 时额外发 wake RPC，RPC 失败不撤销已保存信件。inactive session 另有恢复请求，恢复成功也不是 provider 接收证据；`wait` 路径继续观察对应输入及本轮结果。[sendSessionMessage.ts:429](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/session/services/sendSessionMessage.ts#L429)

入队 helper 统一构造 payload，并按 localId 做确定性加密，避免同一逻辑请求重试时因随机 nonce 产生冲突。它只负责入队，不同时负责恢复/等待。[admitSessionUserMessage.ts:12](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/session/services/admitSessionUserMessage.ts#L12)

**与我们不一样的地方必须保留：** 该链路最终构造的是 `role: 'user'`、`meta.source: 'ui'`、`sentFrom: 'cli'`；所核验的 send service 没有把调用 Agent 的长期 conversation ID 作为我们的 `senderConversationId` 信封字段传进去。这是 Happier 的 session-control 语义，不能直接复制为“所有 Agent 来信都拥有直接用户授权”。我们目前保存 `senderKind`、发送 conversation/run、收件人、回复关系的做法更适合本项目显式 A/B/C 通讯。[admitSessionUserMessage.ts:51](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/session/services/admitSessionUserMessage.ts#L51)

另一个范围差异：Happier 此发送服务拒绝 archived session；我们 G2 归档仍可收信、回收站拒绝新信。借鉴实现不应悄悄改变本项目既定语义。

## 3. 哪条路径保持同一 TUI / GUI writer

| 路径 | 已核验实现 | 对我们的适用性 |
| --- | --- | --- |
| Claude unified terminal | 目标 terminal host 的 `activeHandle` 接收受控输入，Pending queue、草稿检查、runtime controls、hook/transcript 分工 | 最贴近当前 daemon 持有 PTY 的架构；可借鉴单目标输入仲裁与结构化结果 |
| Claude remote / SDK stream-json | spawn 独立 Claude 子进程，stdin/stdout 管结构化消息与 permission control | 适合明确由该进程承载的会话；不能直接拿来给已经运行的另一个 TUI 发消息 |
| `execution.run.start` | 创建 backend controller，再 `startSession` 或加载某个 vendor session；可挂在父 session 下 | 属于子执行任务/执行器，不是原 TUI 的等价输入接口 |

### 3.1 unified terminal：注入与确认分开

- `runClaudeUnifiedTerminalSession` 直接将输入交给 `hostResolution.adapter.injectUserPrompt(activeHandle, ...)`；写入边界支持 `authorizeBeforeWrite`，跨边界异常区分 before/during write 与 duplicate risk。[runClaudeUnifiedTerminalSession.ts:1705](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/unifiedTerminal/runClaudeUnifiedTerminalSession.ts#L1705)
- 输入先做 runtime controls，再检查用户草稿；发现用户正在输入、不可识别草稿或界面忙会 defer，不把新提示词拼进用户残留输入。[createClaudeUnifiedPromptInjector.ts:189](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/unifiedTerminal/createClaudeUnifiedPromptInjector.ts#L189)
- arbiter 明确分开 injected 与 provider acceptance；回执通过 hook/transcript 发现，再关联 Pending localIds/seq。其 transcript 匹配 helper 在没有这些投递身份时还有文本回退，不能据此声称每一条匹配都具有原生 UUID 级强度。[createClaudeUnifiedInputArbiter.ts:79](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/unifiedTerminal/createClaudeUnifiedInputArbiter.ts#L79)、[acceptedPromptDeliveryIdentity.ts:40](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/unifiedTerminal/acceptedPromptDeliveryIdentity.ts#L40)
- 本地启动会话也获得 Happier MCP 配置与 hook；unified 启动构造器将 MCP 和补充 system prompt 带给该 TUI 进程。因而“在原 TUI 中提供正式 MCP 工具”与“使用 headless SDK”不是绑定关系。[claudeLocalLauncher.ts:455](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/claudeLocalLauncher.ts#L455)、[buildClaudeUnifiedTerminalSpawn.ts:265](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/unifiedTerminal/buildClaudeUnifiedTerminalSpawn.ts#L265)

因此最小可借鉴项是把正式工具接到我们已有 `peerSend/peerInbox/peerOutbox`，保持接收侧仍为 `peer-delivery → ai-command-owner → 同 PTY`。不要再引入一套 MCP 专属消息数据库或第二个 stdin writer。

### 3.2 受控 stdin：不要误认成现有 TUI 的管道

Happier Claude SDK query 构造 stream-json 模式并 spawn `stdio: ['pipe','pipe','pipe']` 子进程，向它的 stdin 写 prompt/control 数据。`can_use_tool` 请求用 `request_id` 对应 `control_response`，缺少 canonical tool-use ID 拒绝处理；取消会中止相关 controller。[query.ts:184](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/sdk/query.ts#L184)、[query.ts:262](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/sdk/query.ts#L262)、[query.ts:430](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/sdk/query.ts#L430)

这证明它拥有所启动进程的结构化双向通道，不证明 `--resume` 到同一个 native ID 后能与另一个仍运行的交互 TUI 安全并发写入。我们若采用此模式，应明确切换执行归属并验证单 writer；当前需求并不需要为增加 MCP 工具而做这项改造。

`execution.run.start` 也会调用 backend factory，并创建/加载 child session。父 session 能展示任务结果，不等于该 child 与父 TUI 是同一个执行器。[startExecutionRun.ts:413](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/agent/executionRuns/runtime/executionRunManager/startExecutionRun.ts#L413)、[startExecutionRun.ts:487](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/agent/executionRuns/runtime/executionRunManager/startExecutionRun.ts#L487)

## 4. permission 是有应答对象的回路，不是猜一个 y

Happier 至少有两层不同的批准机制：

1. **应用 action 批准**：统一 executor 根据 action、表面和 settings 决定是否创建 approval；不是看到工具注册就无条件执行。[actionExecutor.ts:1388](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/packages/protocol/src/actions/actionExecutor.ts#L1388)
2. **Claude provider 工具批准**：本地 `PermissionRequest/PreToolUse` hook 对应已发布的 request，UI/RPC 应答再生成 hook-specific allow/deny response。代码区分 request/tool 信息、存活 waiter、过期时间；hook 已失效时不能把迟到点击报成已批准。[localPermissionBridge.ts:46](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/localPermissions/localPermissionBridge.ts#L46)、[localPermissionBridge.ts:818](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/localPermissions/localPermissionBridge.ts#L818)、[localPermissionBridge.ts:912](https://github.com/happier-dev/happier/blob/d06e287b42e7b73a48159c21731d33d95e966801/apps/cli/src/backends/claude/localPermissions/localPermissionBridge.ts#L912)

以上能帮助我们以后把“有具体工具批准请求”接成可靠 GUI 操作。但 G3 记录里的 assistant 文字拒绝，不自动等于存在一个等待批准的 provider tool request。没有请求就不能伪造一条 permission，再借“批准”名义将来信升级成用户任务。已有 accepted 回执继续保留，是否回应另看原生输出。

## 5. 与我们 G2 的具体对应

| Happier 已有结构 | 我们现有机制 | 可借鉴的最小改动方向 |
| --- | --- | --- |
| 会话内 MCP，默认 session 来自已绑定 client | 终端 IPC 凭证、context、expectedConversationId + expectedRunId | 增加一个会话范围工具包装，内部复用现有 IPC；工具调用前仍核对双身份，不能每次暗中刷新 pin |
| MCP tool schema 与 action settings | shell helper 的参数和可信 sender 校验 | 正式暴露 send/inbox/outbox 的结构化参数与错误，降低 CLI 命令拼接及工具发现成本 |
| durable Pending 先入库，wake 只加速 | peer_messages/peer_deliveries + daemon 调度 | 继续复用现有队列，MCP 返回保存/投递状态，不产生第二封信或第二 writer |
| 注入结果与 provider acceptance 分开 | command 回执、source/native ID、uncertain | 保持更强的 source + nativeMessageId 核对，不为了“工具看似成功”降级成文本匹配 |
| request-scoped permission response | 当前 CLI 状态与输入保护 | 仅在真实 provider 支持明确应答协议时接 GUI 批准；其余继续留在原 TUI |
| execution runs 子任务 | 目前需要 A/B/C 各自已有会话通讯 | 不引入子执行器来冒充同一 TUI 同步；未来独立任务需求另行设计 |

本项目对应实现：[peer-delivery.ts](../../packages/terminal-daemon/src/peer-delivery.ts)、[agent-message.mjs](../../scripts/agent-message.mjs)、[peer-messages.ts](../../packages/workspace-store/src/peer-messages.ts)、[ai-command-owner.ts](../../packages/terminal-daemon/src/ai-command-owner.ts)。这些运行归属与持久证据无需因更换入口而重写。

## 6. 不能从本轮调研推出的结论

- 不能说 Happier 的 MCP 已证明能让当前 Claude 版本稳定完成我们的 A → B → A；本轮没有跑模型，也没有对应原生证据。
- 不能说工具被注册就一定会被模型调用，或用户写入一次协作任务后 Agent 一定不会拒绝。
- 不能把 Happier 的所有发送入口归为同 TUI，也不能将其全部归为 headless：上面两类执行路径都真实存在，需按运行模式选择。
- 不能把我们 helper 换成 MCP 后顺便开放跨设备来源、自动启动恢复、任意 Agent 权限或全 CLI 支持。

若下一步批准实施，最值得做的有限实验是：**在一个隔离的新 Claude TUI 启动时安装仅含现有通讯能力的会话 MCP，沿用 G2 身份/队列/单 writer，再用同样证据标准验证工具发现、用户允许或拒绝、精确接收及回信。** 这是一项待验证方案，不是已确定能消除 G3 拒绝的修复。本轮未实施该实验。
