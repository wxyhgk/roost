# G2 独立测试结果

日期：2026-09-09。测试负责人：database_test_review Agent。范围：消息持久化、run 归属、模拟投递、changes 补收与 HTTP/WS；业务由其他 Agent 实现，测试独立设计并吸收反方反例。

本轮使用合成消息、临时 SQLite、临时 socket 和 fake runtime；最后补充了真实隔离 socket/PTY 的 owner RPC 与辅助脚本接线测试。没有读取私人对话、操作日常 daemon、请求真实模型或开启真实 CLI 自动发送。

## 最终结果

| 检查 | 实际结果 | 本机日志 |
| --- | --- | --- |
| workspace-store 全量 | 74 通过，0 失败，0 跳过；退出码 0 | `/tmp/g2-store-full.log` |
| backend 全量 | 165 通过，0 失败，5 opt-in 跳过；总计 170，退出码 0 | `/tmp/g2-backend-full.log` |
| terminal-daemon 最终全量（含 IPC 接线） | 46 通过，0 失败，2 opt-in 跳过；总计 48，退出码 0 | `/tmp/g2-daemon-with-ipc-final.log` |
| 真实隔离 owner RPC 与辅助脚本专项 | 2 通过，0 失败；退出码 0 | `/tmp/g2-peer-ipc.log` |
| 最后 listActive 优化后的投递专项 | 10 通过，0 失败；退出码 0 | `/tmp/g2-owner-last-active.log` |
| 三包类型检查 | workspace-store / backend / terminal-daemon 均通过 | `npm run typecheck --workspace …` |
| 模块边界检查 | 通过 | `node scripts/check-boundaries.mjs` |
| 本轮测试 diff whitespace | 通过 | 限定新增/修改测试文件的 `git diff --check` |

新增长期回归共 40 个：store 22、HTTP/WS 6、daemon 12。日志在 `/tmp`，不作为长期存档承诺；仓库内测试文件和下述操作/断言可复现结论。以上结果针对共享 dirty checkout 的本轮文件状态，没有发布/生产迁移含义。

## 持久库和身份

- `conversation-runs.test.ts`：6 个用例。相同 owner + 精确 binding 观察不创建重复 run；不同 owner 拒绝抢占；明确退休旧 owner 后旧 run 为 unknown 而非伪造退出，新 epoch 递增。A→B→A 切换保留各 run/source 对应关系。拒绝旧 revision/instance/generation/native ID 和关闭的终端；删除终端保留 run 摘要与历史；缺少连接能力的 SQL writer 无法修改 run/epoch。
- `peer-messages.test.ts`：9 个用例。跨 run 的同 conversation/requestId 幂等，旧 run 不因重试绕过身份校验；不同 sender 或不同 requestId 不因正文相同被吞。相同键修改内容/目标冲突；只允许原 recipient 回信原 sender；普通 assistant 输出不自动转发。
- FIFO、uncertain 阻塞、完整 run claim、目标切换、命令正文摘要、原生回执缺失/重复/跨 source 等均有断言。取消只能发生在 queued；已经写入的 cancelled command 映射 uncertain；回收站拒绝新信但合法既有请求可查询。终端删除后信封、收件箱/发件箱、已确认回执保留，离线来信仍排队。
- 故障注入：在 delivery INSERT 前拒绝写入，检查 envelope 与 inbox/outbox 同时回滚；旧 writer 不能删除信封或伪造 accepted。分页与正文预览有界，cursor 不可跨收件箱/发件箱复用，超字节限制/控制字符写入前拒绝。

## 变更日志与快照

`conversation-changes.test.ts`：7 个用例。

1. changes 写入触发故障时，业务标题更新与 revision 一起回滚，不产生可补收的虚假事件；成功提交后能读到相应 revision。
2. Agent 发信同时产生 sender/recipient 两侧引用同 messageId 的变化；change payload 不重复保存正文。
3. 按 conversation 过滤有全局序号空洞时分页不漏/不重复，追平 cursor 前移到全局扫描位置；重开 store 后 cursor 仍能续读。
4. 保留窗口外返回 resync_required；floor 本身可续读；清空所有日志再新增时 seq 不倒退。
5. scope、lineage、未来/负数序号及版本不匹配都明确拒绝；单页 obeys 512 KiB 预算。
6. 实际 `conversationSnapshot` 返回数据与上界 cursor 成套，历史正文随后提交可补收。
7. 已收编反方的真实跨进程快照反例：父事务首个 SELECT 后启动子进程向同一 WAL 库提交新信；父快照 inbox=0，当前 inbox=1，父 cursor 后能补收新信。查询未被模拟，证明这个并发交错下没有“新 cursor 覆盖未读数据”的窗口。

## HTTP 与 WebSocket

`backend/tests/peer-messages.test.ts`：6 个用例。

- 实际临时 HTTP server 验证 202 只表示排队成功，sender 固定 user，拒绝请求体冒充 Agent；幂等重试、冲突、详情、取消、终端删除后的离线读信有效。
- 400/404/405/413 和字节上限检查，错误请求不增信件。
- 实际 WebSocket 使用 HTTP snapshot cursor：先提交消息再订阅，初始补收可见；连接中后续提交由 poll 推送，seq 无重复。HTTP changes 与 WS 共用 cursor 契约。
- 新 gateway 实例拒绝旧 gateway epoch cursor；同实例日志被 prune 后也返回 resync_required。
- 对 backpressure 使用精确控制 bufferedAmount 的 fake socket：慢客户端被断开，另一客户端仍收到快照/更新；dispose 清理监听器并发 1012，入站数据以 1008 拒绝；无效 cursor 先返回明确错误。

## 投递边界与崩溃

`packages/terminal-daemon/tests/peer-delivery.test.ts`：10 个用例。

- 构造协调器不认领、不恢复、不发信；start 后不支持/忙/草稿/权限弹窗均不提交。协调器仅调用 command owner，测试 runtime 的直接 writeSession 会立即失败，防止另开 PTY 写入路径。
- 同一个稳定 commandRequestId 传递可信来源前缀，投递给目标 B 的精确 native/terminalInstance，C 未收到。accepted 回执已持久但 IPC 响应丢失时读取原记录，不重发。
- claim 已提交却无 command 的模糊边界变为 uncertain，新 owner 不重试且阻塞后续来信；原生写入后回执丢失同样不重发，后到的精确回执可解除 uncertain。
- 真正子进程崩溃用例：子进程先提交 writing command，向平台数据库之外的 fake-native ledger 写入并 fsync，再发 IPC 屏障；父进程 SIGKILL 子进程并恢复 owner。ledger 始终只有 1 条，替代 owner 的 enqueue 次数为 0，delivery 为 uncertain。这验证外部接收/平台回执非原子边界，不是实际模型执行证明。
- 实际 `createAiCommandOwner` 回归：claim/enqueue 后同 binding 的 owner epoch 被替换，旧 command owner pump 的 PTY write 次数为 0。
- 临时 Unix socket 已被占用时，实际 `startTerminalOwner` 返回 EADDRINUSE，已有 queued command 不被恢复/取消；成功 listen 后才执行恢复。该用例不创建 PTY，也不触及日常 daemon。
- Agent 入口按当前终端核验，要求 expectedConversationId + expectedRunId。缓存旧双 pin 的 helper 在同 terminalInstance 换 native 后重发原请求，得到 sender_changed 且 inbox 仍 1；缺 pin 得到 sender_pin_required，不重新解释为另一 Agent 的新信。

## 实际 owner RPC 与辅助脚本接线

`packages/terminal-daemon/tests/peer-ipc.test.ts`：2 个用例，独立执行通过后再串行运行 daemon 全套，最终 46 通过 / 2 跳过。

- 启动临时 dataDir 的实际 owner、Unix socket、两个实际 PTY 与不加载用户配置的 Bash。只有“CLI 已被识别”这个前置条件使用 runtime.getSession 包装返回 synthetic omp，原生会话 binding 也是合成的；它不是 OMP 本体兼容测试。
- 在测试 PTY 中执行 Node，把它自身的 ROOST_AGENT 环境凭证写入自有临时 0600 文件。凭证不出现在测试日志、CLI argv 或报告中，结束时清理。
- 通过实际 owner `peerContext` / `peerSend` / `peerInbox` / `peerOutbox` RPC 获得 context、按双 pin 发信并幂等重试。错误 token 返回 403 forbidden；同实例换 native 后旧 pin 返回 sender_changed；销毁并重建 PTY 后旧 instance/token 被拒绝。收件箱仅一条，ai_commands 为空，不触发模型输入。
- 调用 daemon 注入路径的真实 `scripts/agent-message.mjs`，使用测试 PTY 的自身环境，验证 context、send、inbox、outbox 和相同 request ID 重试。脚本收到过期 pin 时退出码 1、stderr 为 sender_changed；输出不包含凭证。
- 第一轮辅助脚本用例仅因测试把 `sender_changed` 错写为带空格文案而失败；按实际稳定代码修正断言后专项 2/2 及 daemon 全套通过，没有修改生产行为来迎合测试。

## 本轮失败、反例与修正记录

- runs 的 Error 类型最初再次使用 strip-only 不支持的 TS parameter property；测试审查及时指出，实现者改普通字段声明，保留原裸 Node 导入回归。
- owner epoch 写入边界、失败 socket acquisition 不得恢复、同 terminalInstance 动态 sender 串号由反方给出反例，协调/实现 Agent 修复后已纳入上述长期测试。
- 首轮三个包并发回归时，既有 `owner.test.ts` 失败：400ms 后仅收到 shell prompt，未见 `__OFFLINE_MARK__`。独立重跑虽通过，但没有直接当作修复。经协调者授权，测试改为最多 100×50ms 有界重读**同一 cursor**等待实际 marker，保留 PID/instance/catchup 全部断言及原总超时；最终 daemon 单独全量通过。首次失败日志 `/tmp/g2-daemon-full.log` 保留。

## 复现与范围限制

```sh
npm test --workspace @roost/workspace-store
npm test --workspace backend
npm test --workspace @roost/terminal-daemon
npm run typecheck --workspace @roost/workspace-store
npm run typecheck --workspace backend
npm run typecheck --workspace @roost/terminal-daemon
node scripts/check-boundaries.mjs
```

G2 的上述自动化范围通过，包括本地辅助脚本到真实 owner RPC 的隔离接线。G3 的真实模型是否调用该工具、CLI 原生接收协议、TUI 实际重绘、GUI 浏览器双向闭环和模型调用仍未验收；没有浏览器视觉或生产服务重启结论。FIFO/cancel/trash 用例覆盖受控的边界先后次序，不宣称已完成任意规模多机/多进程压力测试。store lineage 与 gateway epoch 分层验证，不能把单独 store cursor 宣称为完整备份恢复检测。
