# 对话数据库与 Agent 间通讯设计

日期：2026-09-09。状态：设计草案；未实施数据库迁移、业务代码或前端改动。

本设计补充 [产品调研与独立对话数据库方案](01-product-research.md)。新增要求是 A、B、C 三条 AI 对话可按稳定 ID 相互发消息，TUI 与 GUI 观察同一原生执行过程。以下是本项目设计选择，不是对第三方产品私有数据库的描述。

## 1. 先确定产品语义

- 通讯地址属于长期对话，不属于浏览器标签、PID 或临时终端。恢复同一原生对话仍使用同一地址；切换到另一原生对话或 fork 使用另一地址。
- 第一版 `conversationId` 就是 Agent 通讯地址。A、B、C 是可修改的显示名，发送使用完整稳定 ID。目录可返回当前在线状态与收发能力，不能根据显示名猜目标。
- 暂不增加独立 `agents` 表：当前“一条对话中的 Agent”没有与对话不同的长期生命周期。以后若有一个“审查员”角色管理多条对话，再引入 `agent_id -> 当前 conversation_id` 的显式路由，并让发送者确认路由版本；不能悄悄改变现有 conversationId 的含义。
- A 发给 B 不等于把 A 的整个上下文复制给 B。默认只交付本条正文和可信来源说明；A、B、C 的历史与上下文仍各自独立。
- B 接收并处理 A 的消息后，B 的正常回复属于 B 对话。回信给 A 是另一次明确发送，带 `inReplyTo`；不把所有 assistant 输出自动转发，否则容易形成互相触发的循环。
- 入库、交给 CLI、CLI 确认接收、产生回复分别表示不同事实。收到不表示任务完成，也不表示模型已理解。

## 2. 三类 ID 必须分开

| ID | 含义 | 何时改变 |
| --- | --- | --- |
| `conversationId` | 长期对话及通讯地址 | 新对话或分叉；重开原对话不变 |
| `runId` | 本次原生 Agent 执行实例 | CLI 重启或恢复新执行；仅浏览器重连不变 |
| `messageId` | 一次逻辑通讯的信封 | 新发一条才改变；同请求重试不变 |

保留 `sourceId` 表达 CLI 原生来源，`nativeMessageId` 表达 CLI 生成的消息，`deliveryId` 表达某个收件人的投递。它们都不能与上面的 ID 混用。既有 `webSessionId + terminalInstanceId + generation` 继续用于运行校验，不能变成长久通讯地址。

## 3. 持久化模型：目录、正文、收件箱与执行分开

继续使用现有 SQLite 和 workspace-store。第一版不增加消息中间件或外部数据库。

### 3.1 `conversation_catalog`：长期目录（沿用上篇方案）

字段：`id`、标题及标题来源、可空项目归属、创建/修改/最后消息时间、归档/回收站/置顶时间、元数据 `revision`、可空 `forked_from_id`。

补充 `inbox_policy`，第一版仅需 `disabled | queue_when_idle`。不支持输入的 CLI 默认 disabled；活跃投递必须再次检查适配器能力。离线可保存信件，但默认不因陌生来信自动启动 CLI；用户恢复原对话后，根据策略继续处理未尝试的信件。

`conversation_catalog` 负责整理状态；不要把 running、waiting、failed 混进 archive/trash 字段。

### 3.2 `conversation_sources`：可验证的原生身份（沿用并补足）

字段：`id`、`conversation_id`、`legacy_conversation_id`、`origin_scope`、`cli_id`、`native_session_id`、cwd、版本化原生定位信息、覆盖情况和核验时间。

约束：`UNIQUE(origin_scope, cli_id, native_session_id)`；第一版一个 catalog 只对应一个原生来源，不隐式合并不同 CLI。

**仅新增映射表还不够。** 现有 `ai_conversations` 的 `UNIQUE(cli_id,native_id)` 和 `[local,cliId,nativeSessionId]` 摘要也会合并不同来源。启用多来源之前必须把底层查找/唯一约束改为带 scope，保留旧主键和消息引用。旧数据放入确定的 legacy scope，不伪造已经证实的来源。

### 3.3 `conversation_runs`：谁当前有权接收原生输入

字段建议：

- `id`、`conversation_id`、`source_id`。
- `terminal_id`（允许解除关联）、`terminal_instance_id`、`binding_generation`、`daemon_instance_id`。
- `owner_epoch`、`state`（active/ended/unknown）、`started_at`、`ended_at`、`end_reason`。
- `last_verified_at` 与可空的恢复请求 ID。

一个 source 同时只允许一个由本应用控制的 active run，可用条件唯一索引约束；多个 GUI 只读观察者不创建多个 run。外部不受控进程不因数据库有锁就被禁止，发现原生执行归属不清时应阻止发送。

`owner_epoch` 是交接时增加的代次，daemon 执行前核对它与绑定身份。旧 owner 不再有写权限。数据库字段不会自动阻止一个失控进程写 PTY；本地 owner 仍需在实际写入边界检查，并在接管前确认旧写入者退出或已隔离。

归档状态不代表 CLI 停止，run 的 `active` 也不代表可立即接受输入。busy、权限弹窗、用户草稿与输入通道能力由运行时重新判断。

### 3.4 `peer_messages`：不可变通讯信封

字段建议：

- `id`、`sender_kind`（agent/user）、`sender_conversation_id`（用户发送可空）、`sender_run_id`（历史溯源）。
- `sender_scope`、`client_request_id`、`payload_hash`。
- `body`、版本化 `format`、`created_at`。
- 可空 `in_reply_to`、`correlation_id`；`causation_id` 用于显式因果链。

约束：`UNIQUE(sender_scope, client_request_id)`。相同幂等键和相同规范化内容返回原信封；不同内容或收件人返回 409。摘要包括目标集合、正文、回复关系等业务字段。sender_scope 由后端调用上下文决定，不能只相信请求体自报来自 A。

正文按独立接口按需加载，列表只返回预览。第一版复用现有输入字节上限，跨 CLI 投递前再检查目标限制；不截断用户消息后冒充完整交付。已发正文不原地修改，补充内容另发一条。附件以后通过已有附件 ID 引用，不能靠临时浏览器路径。

### 3.5 `peer_deliveries`：每个收件人独立的耐久收件箱

字段建议：

- `id`、`message_id`、`recipient_conversation_id`、`enqueue_seq`。
- `state`、`reason`、`revision`、创建/更新时间。
- 可空 `target_run_id`、`target_owner_epoch`、`command_session_id`、`command_request_id`。
- 可空 `accepted_source_id`、`accepted_native_message_id`、`accepted_at`。

约束：`UNIQUE(message_id, recipient_conversation_id)`。索引覆盖 `(recipient_conversation_id, state, enqueue_seq)`。`enqueue_seq` 由数据库分配，不能用时间戳假装无冲突的顺序。

建议状态：`queued -> dispatching -> accepted`，另有 `failed / uncertain / cancelled`。queued + reason 可表达 offline/busy/unsupported，避免每个阻塞原因都增加一套状态。接受后是否产生了回信另查 `in_reply_to`，不把投递状态改为“任务完成”。

先实现单收件人 API；未来 A 同时发 B、C 时一份信封对应两条 delivery，各自成功/失败，不需要复制正文。限制 fan-out 和待投递队列大小，防止递归自动通讯耗尽本地资源。

数据库收件箱允许恢复后投递尚未尝试的消息；一旦选中 run 并开始写入，不得因同一个终端后来变成另一条对话而自动改发。投递不确定会阻塞该目标的后续自动发送，直到得到接收证据或用户明确处理。

### 3.6 复用 `ai_commands`：原生写入尝试，不再承担信箱所有权

现有 command owner 已处理用户草稿、身份代次、原生接收证据和 uncertain。保留这个执行层，不另写一个后台 PTY 写入器。

- 一次 delivery 使用稳定、可重算的 command request ID。提交 daemon 后响应丢失，重新查询同一个 command，不凭超时创建第二次输入。
- 新增 delivery/run 关联与来源限定；回执去重改成 `source_id + native_message_id`，现有单纯 native ID 不足以区别不同 CLI/存储来源。
- 历次尝试应可追溯。确定尚未写入的失败才可产生下一次尝试；不确定写入不能自动重试。第一版只做一次自动尝试即可。
- 删除终端不能删掉有 delivery 引用的 command/回执。现有 `store.ts` 中 `aiCommands.remove(id)` 路径必须调整，不能只改对话历史保留。
- daemon 重启后的现有 cancel/uncertain 结果，应由信箱协调器读取并持久映射；不能直接重置所有 delivery 为 queued。

队列幂等能避免本应用重复创建记录，但数据库事务不能与第三方 CLI 的执行成为一个原子事务。无法证实原生收到时显示 uncertain，不承诺模型执行“恰好一次”。

### 3.7 `conversation_changes`：GUI 的耐久变更游标

字段建议：全局递增 `seq`、`conversation_id`、`kind`、`entity_id`、`entity_revision`、小型版本化 payload、`created_at`。索引 `(conversation_id,seq)`。

它是提交后推送和断线补收的日志，不是又一份完整聊天正文。修改目录、信封/投递状态、原生历史入库时，在同一 SQLite 事务内写入对应变化。A 发 B 时为 A 的发件箱与 B 的收件箱各写一条引用同一 messageId 的变化。

- WebSocket 按已提交 seq 推送，客户端断线后带 cursor 补收；重复事件按 seq/entity revision 消重。
- cursor 带数据库 lineage 标识，防止恢复旧备份后把不同数据库序列当作同一进度。
- 初始化快照及上界 cursor 需在同一读事务中获取；然后从上界补收。订阅/补收切换必须处理竞态，不能有“先读后订阅”的丢失窗口。
- 客户端处理的是“扫描到哪一条”的 cursor；按 conversation 过滤时序号有空洞是正常现象。
- 定期保留有界变更日志，保存最低可补收游标；超出保留窗口明确返回 resync_required，重读快照，不能悄悄跳过。
- 历史消息 revision/epoch、GUI 变更 cursor、PTY output seq 是三套不同用途的序号，不能强行共用。

当前 gateway 与 daemon 各有连接；事务要求针对每次业务入库与其变化记录，不把 IPC 和数据库写入假装成跨进程原子提交。桥接层要能在启动和断线后扫描 command/原生历史，幂等补齐还未投影的状态。

## 4. A 发给 B 的完整路径

1. A 通过工具调用或本地命令发 `send_message(to=B, text=..., requestId=...)`。服务从运行上下文解析 A，验证 B 是目标对话。每个适配器要提供 Agent 可调用的工具/命令入口，仅有 HTTP API 不会让模型自动会用。
2. 单事务保存信封、B 的 delivery、A/B 的变更记录，再返回 `202 + messageId + queued`。这时只承诺保存成功。
3. GUI A 显示“发给 B，排队中”；GUI B 显示独立的“待交付来信”。待交付来信不伪造成 CLI transcript 中已经存在的 user message。
4. owner 选择并校验 B 当前 run，在 B 空闲且用户未输入时，通过现有 command 通道把正文交给 B 的同一原生会话。来自 A 的说明由适配器生成；保存实际投递内容摘要，方便关联。
5. 有原生回执/受验证的 transcript 证据时，delivery 变为 accepted，并关联 B 的原生 user message。GUI 将待交付卡片与该消息关联，避免重复显示两份正文。
6. B 的真实回复经现有 transcript/事件采集入库，再推送 GUI；TUI 继续显示原生进程输出。
7. B 明确发 `send_message(to=A, inReplyTo=messageId, ...)` 才形成回信。B 发给 C 同理。A 自己终端已退出也不影响回信先进入 A 的持久收件箱。

自动回复链需要有上限和暂停入口；不因“收到一条消息”就让服务自动生成无限回信。第一版不替 Agent 编造完成结果或任务状态。

## 5. TUI / GUI 同步的边界

GUI、Agent 消息入口共用同一条原生输入队列；TUI 手工输入仍经 daemon 统一管理，不能与自动投递覆盖草稿或交错写入。原生对话 transcript/事件是“CLI 已接受和产生了什么”的依据，信箱是“平台收到什么投递请求”的依据。

数据库本身无法让第三方 TUI 重新绘制。必须验证适配器确实向这个 TUI 所属的原生会话提交，且其 TUI 会刷新；不允许为了实现 GUI 回复在后台另开一个使用相同 native ID 的写入进程。

GUI 可以提前显示排队状态，TUI 未收到时不要求提前出现同一条文字。CLI 不支持可靠输入/原生刷新时，明确显示“只能查看/来信待处理”；收件箱仍有价值，但不能宣称双向同步已经支持。

不把 B 发出去的信件强行伪造成 A/B 原生 assistant 输出，也不通过往 PTY 输出流注入装饰文本破坏 TUI。Agent 若从工具调用发信，TUI 是否展示这次工具调用由 CLI 的实际能力决定。

## 6. 第一版接口形状（建议）

```json
POST /api/conversations/{B}/inbox
{
  "requestId": "caller-stable-id",
  "text": "请检查计算结果的单位。",
  "inReplyTo": null
}
```

发送者从用户/Agent 调用上下文获取；GUI 用户发送不能自报是某个 Agent。用户对 GUI 的普通输入与 Agent 来信应进入同一调度层；信封保留真实 sender kind。

- `GET /api/conversations`：稳定地址、目录与收发能力；复用独立对话目录。
- `GET /api/conversations/:id/inbox` / `outbox`：分页读取通讯及状态。
- `GET /api/peer-messages/:id`：详情与投递证据。
- `POST /api/peer-deliveries/:id/cancel`：只取消尚未尝试的投递。
- `GET /api/conversations/:id/changes?cursor=...` 与对应 WebSocket：断线补收与实时通知。

这只是后端契约草案。初期接口只接受纯文本单目标；回复链、错误码、幂等键复用和游标版本要在实现时固定为契约。

## 7. 对现有方案的推进顺序调整

1. **先落地独立对话目录与原生来源。** 改终端删除路径，保留历史和必要回执；独立列表与读取可用。数据库备份、迁移幂等、旧 API 兼容仍是验收门槛。
2. **通讯基座先于大规模 CLI 发送扩展。** 增加 runs、信封、收件箱、耐久 changes；先用测试适配器验证 A/B/C 路由、排队、重启和消息关联。不把测试通过当成真实 CLI 双向同步通过。
3. **选一个已验证的真实 CLI 跑闭环。** Agent 工具入口 -> A 发 B -> B 原生收到 -> TUI/GUI 都可见 -> B 显式回 A；验证 busy/草稿/离线/uncertain 路径。每类 CLI 按实际版本验收。
4. **逐个开放其他适配器。** 数据库/通信协议共用，只有原生投递、回执与 TUI 刷新逻辑按 CLI 适配。

上篇把 runs 放在单纯历史读取之后仍成立，但在开始 Agent 通讯前必须完成，不能只靠 terminalId 发信。

## 8. 必须测试的失败场景

- 相同请求重试只产生一条信封/每目标一条 delivery；相同键不同内容或目标报冲突。
- A/C 同时发 B，按目标队列序号逐条处理，不能并发覆盖 B 的输入。
- B 忙或有草稿时保留排队；B 切成另一条 native 对话后不误投。
- B 终端删除、daemon 重启、gateway 断线：历史/信件/回执仍在；不确定的原生提交不自动重发。
- 两个 owner 竞争只能一个获得调度权；旧代次不能向新 run 投递。
- 入库后推送前崩溃可补收；原生已接收但回执落库前崩溃要对账或 uncertain，不能声称失败后重发。
- 原生 transcript 重读、revision 更新和信箱投影不产生两条相同的可见输入。
- A 发 B/C 独立记状态；B 的普通回复不会自动发给 A，显式回信才有关联。
- TUI 输入、GUI 输入、Agent 来信争用时不覆盖用户草稿；真正 CLI 实测确认两侧观测的是同一原生会话。
- 最后一条 terminal 引用移除后 catalog、正文、信封与必要回执仍可查询；回收站对话拒绝新投递，已有在途投递单独处理，不能级联静默消失。

## 9. 当前代码依据

- `packages/workspace-store/src/ai-history.ts`：原生来源唯一约束、generation 查询、正文修订和回放序号。
- `packages/workspace-store/src/ai-commands.ts`：按 terminal/request 去重、接收回执索引、重启 cancel/uncertain 逻辑。
- `packages/workspace-store/src/store.ts` / `ai-sessions.ts`：当前删除终端会移除 command 和最后引用的历史。
- `packages/terminal-daemon/src/ai-command-owner.ts`：单 owner 输入仲裁、身份/草稿/版本门控、原生接收证据。
- `backend/src/ai-session-stream.ts`：当前按终端/generation 推送；需要额外的长期对话 changes 契约。

本轮仅完成设计。没有启动 Agent 对话、发送测试消息、修改业务代码、执行迁移或重启服务。
