# G2 实施：持久通讯、运行归属与断线补收

日期：2026-09-09。本批完成后端机制及隔离自动化验证；没有部署、迁移私人数据库、重启日常 daemon、调用真实模型或修改前端。真实 CLI 的 A → B → A 与 TUI/GUI 可见同步属于 G3。

## 1. 用户得到什么

- 对话 ID 是长期地址，终端运行实例是短期状态。终端离线时，消息仍能保存、查询，历史不会随终端删除。
- A 发给 B 的消息有稳定 ID、发件箱、收件箱和投递状态。响应丢失后重试同一个请求，不会创建第二封信。
- 切换终端内的 AI 对话后，旧请求不能悄悄改成新身份发送。旧运行实例也不能在失去归属后继续提交排队信件。
- GUI 可以先取一致快照，再补收持久变更；刷新或断线不用依赖浏览器保存的唯一状态。游标失效时明确重新同步。

“保存成功”“CLI 接收”“AI 回答完成”是三个不同状态。本批的 HTTP 202 只确认前一个；只有真实 command 回执可以将投递置为 accepted，accepted 也不意味着模型完成回答。

## 2. 模块与实际分工

| 范围 | 文件 | 负责人 |
| --- | --- | --- |
| 信封、队列、幂等和回执 | `packages/workspace-store/src/peer-{types,schema,messages}.ts` | conversation_store_impl |
| 运行记录与 owner epoch | `packages/workspace-store/src/conversation-runs.ts`、`run-types.ts` | conversation_runs_impl |
| 持久变更和触发器 | `packages/workspace-store/src/conversation-changes.ts` | conversation_changes_impl |
| HTTP / WebSocket | `backend/src/peer-messages.ts`、`conversation-stream.ts` | conversation_api_impl |
| 调度与 Agent 命令行 | `packages/terminal-daemon/src/peer-delivery.ts`、`scripts/agent-message.mjs` | conversation_runs_impl |
| 共享入口、原生写入保护 | store/index、server、owner、ai-command-owner | 主 Agent |
| 永久测试与故障验证 | store/backend/daemon 新增测试、验证报告 | database_test_review |
| 独立反方 | `verification/g2-skeptic.md` | qwen_adapter，本轮只做反方 |

所有模块复用现有 workspace-store SQLite。没有增加消息服务，也没有另开第二个 PTY writer。

## 3. 持久化与投递规则

运行记录固定 conversation/source、原生 session、terminal instance、binding generation、daemon owner 与递增 epoch。相同有效观察重用 run；绑定变化结束旧 run；接管时将其他 owner 的遗留 active run 标为 unknown，不伪造正常退出。调度只查询当前 active runs。

信封不可修改；一次逻辑发信的幂等范围为 `user:local` 或 `agent:<conversationId>`，不随 run 改变。去重摘要包含目标、规范化正文和回复关系。授权检查先于去重；同一对话更换 run 后，显式取得新身份再重试原 requestId，返回原信件并保留最初 senderRunId。

正文上限 15 KiB UTF-8，为可信来源前缀预留空间；最终仍受现有原生命令 16 KiB 校验。单个目标最多 20 条未决投递，列表正文按需加载。只允许单收件人，禁止给自己发信；非空 inReplyTo 仅允许原 Agent 收件人回复原 Agent 发送者，不自动转发普通 assistant 输出。

同一收件人按入队顺序提交。离线、不支持的 CLI、关闭发送能力、忙、草稿或权限等待都不能绕过现有 command control。调度按活动收件人查询，离线对话的积压不会占满全局第一页后阻挡其他活动对话。

claim 持久记录具体 run/epoch 和稳定 `peer:<deliveryId>` commandRequestId；唯一原生 writer 在队列取出、异步准备后以及实际写入前检查最新归属。提交边界无法确认时置为 uncertain，阻塞该收件人的后续自动投递，禁止换 run 自动重发。迟到且精确匹配的原生回执仍可对账。这里没有“恰好执行一次”的承诺。

取消只支持 queued。回收站拒绝新信并阻止尚未实际写入的投递；已有信件和回执保留，合法幂等重试仍返回原结果。归档不等于回收站，归档对话仍可接收消息。

## 4. Agent 从自身终端使用

新 daemon 创建的终端会获得 `ROOST_AGENT_MESSAGE_CLI` 脚本路径及该终端实例的 IPC 凭证。凭证由 daemon 验证，不能通过 HTTP 自报 Agent 身份。命令行不会打印凭证。

先显式取得当前身份：

```sh
node "$ROOST_AGENT_MESSAGE_CLI" context
# {"conversationId":"...","runId":"..."}
```

将返回的值保存为本次工作的身份，后续命令均明确传入：

```sh
node "$ROOST_AGENT_MESSAGE_CLI" send \
  --from "$sender_conversation_id" --run "$sender_run_id" \
  --to "$recipient_conversation_id" --request-id "$logical_request_id" \
  --text '请检查最新计算结果'

node "$ROOST_AGENT_MESSAGE_CLI" inbox \
  --from "$sender_conversation_id" --run "$sender_run_id" --limit 20

node "$ROOST_AGENT_MESSAGE_CLI" outbox \
  --from "$sender_conversation_id" --run "$sender_run_id" --limit 20
```

`send` 可加 `--reply-to <原消息ID>`。分页使用响应 nextCursor 配合 `--cursor`。缺少身份拒绝操作；身份变化返回 sender_changed。脚本不会在发送前自动更新身份，否则延迟请求可能误归给另一段对话。网络失败需保留原 logical_request_id 和内容；是否显式切换到新 run 由调用者在确认身份后决定。

HTTP 发信始终代表 user，Agent 入口为 `peerContext/peerSend/peerInbox/peerOutbox` 的 daemon IPC。当前凭证用于核验来源终端与防止意外串号，不是同一终端内恶意子进程的隔离沙箱。脚本路径来自当前工作区，不构成独立冻结的恢复产物。

## 5. 同步与生命周期

`conversationSnapshot()` 在同一读事务内读取目录、当前 run、历史/收件箱/发件箱首屏及变更游标，三类首屏各最多 10 条。SQL 触发器在业务事务中写入小型变更引用，不复制正文。客户端据此重新读取对应对象。

changes 每页最多 200 条、512 KiB；WebSocket 每 250 ms 读取最多 100 条。daemon 每 30 秒保留最新 5000 条全局变更。游标表示扫描位置，过滤单对话后序号有空洞是正常现象。

HTTP/WS 游标绑定当前 gateway epoch、数据库 lineage 和 conversation；后端重启、保留窗口外或范围错误要求重新 snapshot。支持离线恢复备份后重启服务，不支持运行中替换数据库文件。元数据变更日志是有界补收窗口，不是无限历史归档。

daemon 成功 listen 并设置 socket 权限后，才恢复 command、接管遗留 run、启动投递和发送 ready hello；竞争启动失败不能提前取消现有命令。停止 owner 时先关协调器与 command writer，再释放 socket/runtime/store。普通 HTTP gateway 重启不拥有或停止 PTY。

## 6. 验收、升级与下一关

独立 QA 覆盖真实临时 SQLite、跨连接/子进程竞争、SIGKILL 边界、HTTP/WS、受控原生 writer 与身份切换；独立反方先复现再复测两处阻塞缺陷：旧 epoch 仍实际写入、同终端重绑后发送者串号。修复后前者实际 write 次数为 0，后者拒绝旧 pins 且不增信件。

最终命令、数量、跳过项和隔离 IPC 接线结果以 [G2 独立测试](verification/g2-tests.md) 为准；反例与限定放行结论见 [G2 反方验证](verification/g2-skeptic.md)。前端开发请使用 [G2 接口契约](09-g2-frontend-contract.md)。

部署仍遵守 [G1 升级约定](06-g1-implementation.md)：一致性备份、旧写入者保护、明确升级 daemon。此轮未执行日常升级，不能认为正在运行的旧 daemon 已自动获得新接口和环境变量。现有原生发送开关保持原值，未为测试启用真实 CLI 自动发送。

G3 下一步选择一种已具备可靠接收及回执的 CLI，在隔离环境完成 A → B → A，并由前端负责人验证 TUI/GUI 对应同一原生消息、草稿保护及刷新补收。其他 CLI 各自重复验收。当前仍固定单本地来源 `legacy-local`；跨设备多来源去重、自动启动/恢复 CLI、人工解决 uncertain 的产品操作和真实 GUI 均不在 G2 完成范围内。
