# G3 前端最小联调清单

日期：2026-09-09。本文件保留最初 Bash 方案的前端盘点和历史试验结果，不宣称 GUI 已实现。该方案第 7 次整测 false，第 8/9 次模型拒绝，原始结论见 [历史报告](verification/g3-tests.md)。后续 MCP 方案修复后已通过限定 Claude 配置的一次真实后端往返；最新状态见 [第十六阶段](16-mcp-postfix-validation.md)，前端接线补充见 [第十七阶段](17-mcp-frontend-handoff.md)。浏览器验收仍未完成。

请求与响应的完整定义见 [G1 契约](07-frontend-contract.md)、[G2 契约](09-g2-frontend-contract.md)，Agent 命令行与权限边界见 [G2 实施](08-g2-implementation.md)。本清单不新增接口。

## 1. 当前前端的真实接线

| 当前文件 | 已有行为 | 本次需要接上的部分 |
| --- | --- | --- |
| [AiSessionView.tsx](../../frontend/src/components/AiSessionView.tsx) | 从 workspace 的 `selectedId` 找未关闭终端，再调用 `useAiSession(session.id)`；没有终端就返回空状态。 | 独立选择长期 conversation ID，终端不存在时仍能展示保存历史；增加收件箱与投递状态的展示入口。 |
| [RightPanel.tsx](../../frontend/src/components/RightPanel.tsx) | AI 页仍作为当前终端的右侧内容，副标题使用终端 cwd。 | 对话内容与当前终端选择分开；离线对话标题、来源由 ConversationRecord 提供。 |
| [api/aiSession.ts](../../frontend/src/api/aiSession.ts) | 仅接 `/api/ai-sessions/:terminalId` 与旧 `/events`；游标是 generation 下的数字 seq，重连固定 `afterSeq=0`。 | 接 `/api/conversations`、snapshot、stream、inbox/outbox 与 peer 详情；新不透明 cursor 不能传入旧接口。 |
| [useAiSession.ts](../../frontend/src/ai-session/useAiSession.ts) | 旧绑定 404 时每 4 秒等识别，并按 terminal ID 重置状态。 | 独立历史按 conversation ID 查询，不以旧绑定存在与否决定是否有历史；终端绑定等待和历史加载分开处理。 |
| [ai-session/store.ts](../../frontend/src/ai-session/store.ts) | 只按 generation/seq 合并事件；`unbound` 会清空 entries。 | 新历史按 conversation/message ID 与 sourceRevision 更新；旧终端 unbound 不能清掉独立保存历史。 |
| [api/errors.ts](../../frontend/src/api/errors.ts)、[api/request.ts](../../frontend/src/api/request.ts) | 已解析 `{error:{code,message}}`，并在 ApiError.body 保留完整 JSON。 | 可复用；显式处理 `resync_required`、`history_cursor_expired`、`request_conflict` 和元数据 conflict/current。 |

上述为当前源码只读盘点。没有在前端找到 G1/G2 对话目录、peer 收件箱或新 stream 的现有调用；不能把当前旧只读面板当成已接通新通讯功能。

## 2. 先固定身份，再展示双视图

- 页面主键使用 `ConversationRecord.id`，即长期 `conversationId`。标题、文件夹名和 terminal session ID 都不能替代它。
- `GET /api/conversations/:id/snapshot` 返回 `conversation` 与 `run`。`run?.webSessionId` 是跳转当前终端的线索；同时检查 `terminalInstanceId`，避免同一终端 ID 已换实例后连错。
- `run: null` 或原终端已退出时，仍保留 conversation、已保存消息与收发件箱。不要自动创建终端，也不要显示“历史不存在”。`run !== null` 只是已观测 active，不保证此刻可输入或恢复。
- 如果从已有终端进入对话页，只能按当前绑定的 `cliId + nativeSessionId` 与已加载目录 `source` 精确匹配；当前后端限定单本地来源。目录尚未加载完整或无唯一匹配时，显示待确认，不能按名称/cwd 猜。从独立目录选择 conversation 再查看 snapshot.run 是更直接的路径。
- 同一终端切换到另一原生对话时，原对话历史保留；GUI 只有明确切换 conversation 后才显示另一条对话。不要把两条对话的 entries 合并。

最小联调布局沿用现有 TUI 区域和右侧 AI 区域即可。联调目标是两边对应同一个原生会话，不要求本批重新设计整个页面。

## 3. 收件箱和原生历史如何避免重复

收件箱记录“谁发来什么、投递到哪一步”；原生历史记录“CLI 实际收到和输出了什么”。两个对象都保留，不能将信封入库直接插成一条已收到的原生 user 消息。

对真实 Claude 输入，关联必须同时满足：

1. 投递为 `accepted`，`acceptedNativeMessageId` 非空。
2. `delivery.targetSourceId === conversation.source.id`，并且 `delivery.nativeSessionId === conversation.source.nativeSessionId`。
3. 当前 conversation 的历史消息 `event.data.nativeMessageId === delivery.acceptedNativeMessageId`；其中 data 须先做对象和字符串类型校验。

Claude reader 的原生 UUID 当前保存在 `event.data.nativeMessageId`，不是 `HistoryMessage.messageId` 或 peer message ID；实现位置为 [claude.ts](../../packages/ai-transcript/src/claude.ts)。以 `(source.id, nativeMessageId)` 作为原生关联键，而不是只比较文本、时间或 UUID。

- 已匹配：正文流保留一条原生输入，将来源与投递状态作为标注；收件箱仍保留审计项或链接，不再额外生成第二条普通 user 气泡。
- 投递 accepted、历史尚未采集：显示“CLI 已接收，历史同步中”，不要凭空构造完整 transcript。随后收到 history 变化再关联。
- queued/dispatching/uncertain：显示在通讯状态区域，不称为 CLI 已收到。uncertain 不自动重发。
- 无精确来源与原生 ID 证据：暂不合并，保留两个对象的不同用途。不要靠相同文字误合并用户重复发送的两次请求。

GUI 内消息列表以 `messageId` 去重并按 `sourceRevision` 更新，peer 投递按 `delivery.id/revision` 更新；这两种 revision 不可互换。accepted 表示输入接收，不表示 assistant 回答完成或协作任务成功，B 的回信也是另一封明确带 `inReplyTo` 的 peer message。

页面应分别展示“CLI 已接收”与 Agent 的实际响应，包括明确拒绝。不能因为 delivery=accepted 就把任务标绿，也不能因为 Agent 拒绝执行而将已确认的接收回执改成投递失败。当前没有通用“任务成功”字段，结果应根据实际消息展示，不从投递状态推断。

## 4. 开始协作前的用户任务说明

真实联调曾出现 A → B 已 accepted，但 B 两次明确拒绝执行：它没有获得本会话直接用户给出的协作任务。项目 `CLAUDE.md` 中的固定任务没有可靠替代这项直接说明。这是执行意图与消息传输的区别，不是应当悄悄跳过的障碍。

随后尝试的联调方案是先由用户通过现有 HTTP 原生命令入口，向 B 明确说明一次受限协作任务：固定参与者 A、测试 marker、允许使用的脚本以及只回复一次；预期再向 A 提交 seed。方案按四次逻辑输入设计：B 的直接用户任务、A 的 seed、A → B 来信、B → A 回信。**这项方案没有通过：第 9 次 B 在用户 bootstrap 本身就明确拒绝，流程停在 A seed 之前，不能将四次预期输入写成已完成。** 直接用户任务没有被证明能解决该拒绝，不能据此承诺稳定协作。

前端可以先接现有只读历史、收发件箱和投递状态接口，明确保留 Agent 的拒绝。后续协作试验需让用户明确给参与者任务，但该说明本身不保证 Agent 会执行。不要在收到来信后暗中生成用户批准、自动答应工具权限或把任意 Agent 来信提升为用户指令。这里描述的是已经尝试但未通过的受限 Claude 联调方案；没有实现通用协作授权产品接口，也不表示所有 CLI 已支持同样的协作方式。

## 5. 最小同步流程

1. 选择 conversation ID，请求 `/snapshot`，将目录、run、三类首屏和顶层 cursor 一起应用。
2. 使用该顶层 cursor 连接 `/api/conversations/:id/stream?cursor=...`；或者直接连接无 cursor stream，使用其首帧 snapshot。不要另外查询“最新 cursor”跳过快照之后的变化。
3. 收到 changes 后按 kind 刷新对应对象：metadata/source 读详情，history 读消息或首屏，peer 读 `/api/peer-messages/:id`。`run.updated` 可重新 snapshot 获取最新 run。小型 changes 本身不含完整正文。
4. 保存最后成功应用的 cursor。并发 HTTP 回读须绑定当前 conversation 和请求代次，旧响应不能覆盖更新的 revision；切换对话时清理旧连接。
5. 断线后用原 cursor 补收；`resync_required` 时重新 snapshot。后端正常重启也会换 epoch，不能拿旧 cursor 无限重连。

`messages.nextCursor`、inbox/outbox 的 `nextCursor` 与顶层变更 cursor 各有用途，不能混用。历史每页内部升序，下一页是更早的内容；peer 列表按 enqueueSeq 倒序。global seq 有空洞正常，即使 changes.items 为空也要应用返回的 cursor。

请求正文保存失败时保留输入和 requestId。HTTP 发信始终代表用户，不能通过 sender 字段冒充 A；真实 A 发 B、B 回 A 使用可信 Agent IPC/脚本完成。

## 6. 用 G3 后端证据核对页面

历史 Bash 测试结果见 [G3 测试报告](verification/g3-tests.md)，最新 MCP 结果见 [修复后验收](16-mcp-postfix-validation.md)。前端联调应使用自己隔离环境的实际 IDs，对照同类证据；不要将已清理测试环境里的 ID 当成日常数据。

| 后端证据 | 前端对应检查 |
| --- | --- |
| A/B 的 conversation、source、native session、terminal instance、run 对照 | 两个页面各自 snapshot 的身份一致，切换不会串历史。 |
| B 的直接用户任务与 Agent 接受、回应或拒绝的原生记录 | 用户任务与 peer 来信来源分别标识；不以投递 accepted 代替任务完成，也不隐去拒绝。 |
| A → B peer message ID、delivery ID、acceptedNativeMessageId | A 的 outbox 与 B 的 inbox 指向同一封信；B 原生历史按来源/原生 UUID 关联，只显示一次输入。 |
| B → A 回信及 inReplyTo | 回信收件人为 A，关联原信；不把 B 的所有 assistant 输出自动当回信。 |
| 真正落盘的 CLI user/assistant 记录与回执 | GUI 原生正文来自保存历史，TUI 对应同一 native session；终端屏幕可见效果仍需浏览器实际核对。 |
| 断线期间 changes、重连后的 cursor 与实际消息 | 刷新/断线补收后不丢、不重复；旧 epoch 触发新快照。 |
| 终端退出后保存的独立历史 | 关闭或退出测试终端后，可从目录再次打开对话并读取已保存正文；不要求启动 CLI。 |

后续最小前端验收完成条件：两个真实 CLI 的 A → B → A 有可核验接收与回信证据，GUI 正确显示对应原生消息和投递状态；刷新补收、终端退出后阅读历史、旧请求不覆盖新对话三个场景在浏览器实际通过。当前这些条件尚未全部满足，G3 未放行；已有后端接口和隔离测试只作为联调基础，不能代替完整真实流程或 GUI 验收。
