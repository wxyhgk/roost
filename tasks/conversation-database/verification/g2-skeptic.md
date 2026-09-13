# G2 独立反方验证

日期：2026-09-09。角色：`qwen_adapter` 本轮作为独立反方，不做 Qwen 适配或业务代码修改。

**当前结论：限定 G2 范围反方放行。发现的 G2-S1（旧 owner 写入）与 G2-S2（延迟发送请求改归新对话）均已修复并独立复测。完整回归和类型检查以独立 QA 报告为准；不包含 G3 真实 CLI/TUI/GUI 通讯验收。**

只使用临时 SQLite、合成对话、fake PTY 与本地临时 HTTP 服务；未调用模型、日常服务或读取私人历史。以下区分自己执行的证据与实现者说明。

## 最少冻结的契约

1. HTTP 发送者只能是可信 endpoint 赋予的 user；Agent sender 必须来自拥有当前终端实例的后端上下文。请求体、header、显示名不能决定 sender 身份。
2. `sender_scope` 属于稳定 conversation；更换 sender run 后同 requestId/正文/目标/reply 返回原信封，保存最初 senderRunId。run 失效后重试也不能绕过授权。
3. delivery 与 command requestId 稳定绑定。dispatching/uncertain 不换 run 重试，不因数据库不存在 command 就重建输入；uncertain 阻塞该 conversation 的后续投递。
4. 原生 **实际 write** 前检查 delivery/run/source/owner epoch、终端实例和 binding。claim 时查一次不够。接管前另须旧 owner 已退出或隔离，SQLite epoch 不能使失控的旧进程自动失去 PTY。
5. snapshot 内容与变更上界同读事务；之后从上界补收，不能在“快照结束→订阅安装”之间丢消息。cursor 包含范围与 lineage/恢复 epoch，过滤游标表达扫描进度。
6. 仅 queued 可取消；trash 拒绝新请求，不删既有信件/receipt，合法重试返回原结果；dispatching/accepted/uncertain 不伪装已撤回。
7. 202 只表示耐久保存请求；queued/dispatching 不生成假 native user message，不表示 CLI 收到或模型执行完成。

## 独立执行结果

| 项目 | 方法 | 结果 |
| --- | --- | --- |
| 跨 run 幂等 | 实际 runs/store，将 A run1 end 后创建 run2，同键重试 | 同 messageId，保留 senderRunId=run1；换正文 409；旧 run 重试拒绝 |
| uncertain 不换 run | claim B run1 后 uncertain，B run2 再 claim 旧件及下一件 | 旧件 already_dispatching，下一件 recipient_blocked；cancel 拒绝 |
| 保存与接收分离 | 实际 peer.send 后查 ai_history_messages | delivery=queued，原生历史新增 0 |
| trash/重试 | B 移入垃圾箱后新键与原键重试 | 新请求 conversation_trashed；原请求仍返回原信封 |
| cancel/claim 跨进程 | 父 SQLite BEGIN IMMEDIATE；独立子进程发 claim；父嵌套 cancel 后提交 | 子收到 already_dispatching，delivery=cancelled，无投递写入 |
| changes 正文隔离、保留窗口 | 实际触发器产生变更，查询后 prune(0) | payload 无测试正文；旧 cursor resync_required |
| HTTP 冒充身份 | 真实临时 HTTP 服务发送 senderConversationId 及伪造 headers | body 自报字段 400；header 无效，合法请求202 senderKind=user |
| snapshot→poll 安装竞态 | 实际 stream，fake WebSocket 的 snapshot.send 回调立即提交新信件 | 第一轮补收包含新 peer.message.updated，未丢失 |
| gateway epoch | 同一 store 创建新 handler，提交上一 handler 的 cursor | HTTP 409/resync_required |
| 旧 owner 实际写入 | 实际 command-owner/headless/SQLite，fake PTY 计数；enqueue 后换 owner epoch | 修复前写 1 次；修复后同探针写 0 次、command=cancelled |

HTTP 与 stream 使用实际业务 handler。fake WebSocket 只固定注入交错，不声称浏览器视觉或真实网络压测。跨进程 cancel/claim 固定一组写锁交错，不是所有时序穷举。

### G2-S1 阻塞反例

复现顺序：

1. 建合成 Claude binding 与 run(owner=daemon-1, epoch=1)。command-owner 使用真实 headless 空 composer，fake runtime 记录 writeSession 调用。
2. 保存 peer message，claim 到 run1，enqueue 同 delivery 的稳定 command requestId。
3. 在 command 尚未真正写入时执行 retireOtherOwners('daemon-2')；相同 binding 由 daemon-2 observe 成 epoch2。
4. 继续 pump 旧 command-owner。

实际输出：

```json
{"oldEpoch":1,"newEpoch":2,"writes":1,"command":"awaiting_acceptance"}
```

原因：peer claim 与 command enqueue 后仍有等待/异步文件读取；旧 command 的原生身份三元组没变。仅检查 binding 的 matches 无法察觉 run owner 已退役。已通知主 Agent 修复 actual write guard。独立原样复测结果：`{"oldEpoch":1,"newEpoch":2,"writes":0,"command":"cancelled"}`。三处同步边界复核 delivery/run/owner/source/identity 与 trash，迟到 receipt 不受写前 gate 干扰。

临时复现脚本：`/tmp/g2-write-boundary.mjs`；完整 store 探针 `/tmp/g2-skeptic-concurrent.mjs`，HTTP/竞态探针 `/tmp/g2-http-skeptic.mjs`。这些不是永久测试文件，不把它们描述成仓库测试套件。

## 明确未覆盖与接受的边界

- G2 未进行任何真实 CLI/TUI/GUI 发信闭环；这属于 G3，不能把 fake writer 结果改写成模型已收到。
- 当前旧备份恢复只支持离线恢复并重启 gateway；数据库内 lineage 自身不能检测同 lineage 的历史回滚。已验证新 gateway epoch 拒绝旧游标，不宣称支持运行中原地覆盖数据库。
- snapshot 各 SELECT 之间的跨进程写入交错已独立复测，见下；仍不声称穷举所有跨进程时序。
- 已独立验证 occupied socket 竞争启动不触发恢复；真实旧失控进程的操作系统级隔离不是 SQLite gate 自动提供的能力，不宣称对恶意旧进程成立。实际 writer gate 已复测，peer coordinator 更广泛故障组合以独立 QA 回归为准。
- 无 inbox policy UI 或自动启动 CLI 的能力不应假装已有；本批 queued 的含义是已保存等待可支持的现有执行实例。

## G2-S2：延迟发送请求被重新归属（已修复并复测）

实际 `/tmp/g2-sender-skeptic.mjs` 使用真实 store/bridge/peer-delivery helper、fake runtime：A 发到目标 C；同一个 terminalInstance 上 rebind 成不同 native B；旧 A 用完全相同 terminal/instance/requestId/text 重试。

```json
{"sameMessage":false,"sameSender":false,"inboxCount":2}
```

原因是 helper 每次按终端动态解析当前 senderRun，没有冻结发请求时的对话身份。终端 HMAC 证明是这个终端的调用，不能单独证明请求属于先前 A。要求 send/inbox/outbox 显式携带 expectedConversationId 与 expectedRunId，后端比对当前身份；context 可以显式发现身份，但 send 重试不能自动刷新成新对话。主 Agent 已安排双 pin 修复；最新独立复测如下。

## 启动竞争独立复测

实际 `/tmp/g2-startup-skeptic.mjs` 使用临时 Unix socket、实际 startTerminalOwner，不创建 PTY。先让另一 socket server 占位，并预存 queued command：竞争启动 EADDRINUSE 后 command 仍 queued；释放 socket 后成功启动才执行 recover 将其 cancelled。输出 `{"failedStart":"queued","successfulStart":"cancelled"}`。这验证 recover 移到成功 listen/chmod 后，失败 contender 不修改现有命令状态。

上述复现资料已经移交独立 QA `database_test_review`，由其决定永久测试文件归属；本反方不越界编辑业务或测试文件。

## Snapshot 读视图的实际跨进程验证

`/tmp/g2-snapshot-skeptic.mjs` 调用实际 `store.conversationSnapshot()`，仅 wrapper `conversations.get` 在其第一条真实读取返回后，同步启动子进程向同一 WAL 数据库保存信件。随后父 snapshot 继续读取 inbox 与 cursor。

```json
{"snapshotInbox":0,"currentInbox":1,"changeAfterSnapshot":true}
```

snapshot 保持旧 inbox/旧上界，同一 cursor 在 snapshot 结束后能补收子进程提交的新信件，证明不是把“新 cursor”错误配上“旧正文”。没有 mock SQL 返回内容，子进程使用实际 workspace-store；所有临时连接和目录已清理。该探针已移交独立 QA。

## 双 pin 修复的独立复测与最终结论

实际 `peer-delivery.ts` 新增 context 显式身份发现；send/inbox/outbox 必须携 expectedConversationId 与 expectedRunId。已查 owner IPC 仅通过当前终端实例 HMAC 后调用这些入口；脚本要求 `--from`/`--run`，没有发送前自动刷新身份的逻辑。

`/tmp/g2-sender-pinned-skeptic.mjs` 独立复测：

1. 同一 conversation 的 run 结束后，显式 context 获取新 run，再用原 requestId 发送，仍返回原 messageId。
2. 同 terminalInstance 切换到另一个 native conversation B，旧请求保留 A 的 pins；send 与 inbox 都拒绝，目标件数不增加。

```json
{"sendError":"sender_changed","listError":"sender_changed","inboxCount":1}
```

可信终端 bearer 加 pins 用于防止延迟请求被意外改归另一身份；不宣称它能隔离同一终端中主动窃取/刷新上下文的恶意子进程。

本反方当前未发现尚未闭合的 G2 阻塞反例。两个缺陷均先实际复现、通知实现者修正，再以原交错复测；没有以实现者口头承诺代替结果。全部临时数据库、服务、fake runtime 与子进程已经清理；只修改本报告，未编辑业务、前端或永久测试文件。
