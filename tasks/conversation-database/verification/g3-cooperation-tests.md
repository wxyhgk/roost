# MCP Agent 通讯：独立无模型测试结果

**本批 MCP 协议与隔离 IPC 验收通过；不改变 G3 真实模型协作不放行的结论。** 没有调用模型、读取私人对话或操作日常 daemon。MCP send 成功在本批真实接线测试中只产生 queued 信件，aiCommands 仍为 0。

## 冻结契约与最终门禁

实现采用 `@modelcontextprotocol/sdk` **1.30.0**、`zod` **4.5.4**，明确选择 v1 的 initialize 协议兼容路线，不称为最新 v2。原始 JSONL harness 实际协商 **2025-11-25**，另用真实官方 v1 SDK client 验证发现和调用。

| 门禁 | 实际结果 | 日志 |
|---|---|---|
| 新包全部测试 | **19/19 pass，0 skip，0 fail**，约 3.02 秒 | `/tmp/mcp-package-tests-final.log` |
| terminal-daemon 全套，串行执行 | **49 tests，47 pass，2 skip，0 fail**，约 22.05 秒 | `/tmp/mcp-daemon-final.log` |
| backend 全套（主负责人执行） | **167 pass，6 skip，0 fail** | `/tmp/agent-messaging-backend-final.log` |
| 新包/backend/daemon 类型检查与源码边界 | 主负责人执行通过 | 主负责人工作记录 |

daemon 完整集合实际命令为 `node --import tsx --experimental-test-module-mocks --test --test-concurrency=1 packages/terminal-daemon/tests/*.test.ts`。本轮从一开始就选串行，降低多个真实 shell/PTY 测试同时启动的调度噪声；没有先运行默认并行命令再失败的过程，因此不宣称本轮验证了默认并行调度。

本批新增 20 条永久测试：新包 19 条，daemon 真实隔离接线 1 条。daemon 全套包含既有 peer-ipc 两项，因此也验证 CLI 脚本改为复用新 client 后的成功 JSON、双 pin、幂等及 `sender_changed` 错误兼容。

持久汇总见 [evidence/agent-messaging-tests.json](evidence/agent-messaging-tests.json)。完整设计矩阵见 [测试计划](g3-cooperation-test-plan.md)，计划中的每个设想并不都在本批实现。

## 实际覆盖

[client.test.mjs](../../../packages/agent-messaging/tests/client.test.mjs) 的 7 条测试覆盖：

- context/send/inbox/outbox RPC 路由、凭证只取 env，保留显式双 pin。
- UTF-8 正文 15 KiB 边界、超一字节、空 pin、分页上下限/小数，以及合法正文转义后总 IPC 请求超过 32 KiB；非法输入不连接后端发送。
- owner error 的 code/status 保留、分片 Unicode reply、hello/错 request id 不被当作本次结果。
- 连接前 abort 无提交；提交后 abort 关闭 socket 且没有自动重发。
- 5 秒以内可配置超时、畸形响应、响应大于 4 MiB，均有界结束。
- 响应嵌套 key/value、错误 code/message 中出现测试 token 时脱敏，不泄漏到结果或错误。

[stdio.test.mjs](../../../packages/agent-messaging/tests/stdio.test.mjs) 的 12 条测试使用真实 MCP 子进程，覆盖：

- initialize/initialized/list/call，四个 agent 工具、strict schema、schema 无 token/socket/terminal 字段；每行 stdout 都是 JSON-RPC，无残留半帧。
- 原始 JSONL 和独立官方 SDK client 两条协议路径；多字节 UTF-8 跨 chunk、通知、ping 与 RPC id 关联。
- 缺 pin、未知工具、未知/伪造身份字段、正文超限不转发；owner 409 sender_changed 的 structuredContent error 保留。
- 初始化完成前 send 不产生 owner 请求，完成后正常调用。
- MCP 取消只释放等待与 socket，不撤销信件或自动重试；fake owner 已保存后取消，再以同业务 requestId 显式重试获得同一信件。
- 8 个在途 IPC 上限；超过 64 KiB 的 stdin 帧有界退出且不转发；17 个同时未返回协议请求触发有界关闭。
- 20 次连续取消释放 RPC 槽位和 socket，之后 ping 与新 call 仍可用。
- EOF、SIGTERM、重复 pending RPC id 均使子进程与在途 IPC 有界退出，无额外发送。

[peer-mcp.test.ts](../../../packages/terminal-daemon/tests/peer-mcp.test.ts) 验证完整的 **MCP SDK client → 真实 stdio 子进程 → 真实 Unix owner → SQLite**：

- 两个真实隔离 PTY 从自身 env 写入仅测试可读的 0600 临时凭证文件；没有模型进程。识别前置条件与 binding 是合成的，不能当作真实 CLI 自动识别证据。
- context、send、inbox、outbox 的 messageId 与数据库一致；同业务 requestId 重试只有一份记录。
- 错 token/旧 instance 拒绝；同一 instance 换 native 后，旧双 pin 的 send/outbox 返回 sender_changed，不刷新身份后偷偷重试。
- 信件停留 queued，A/B 新 aiCommands 都是 0；没有通过 MCP 新开模型 writer 或执行原生输入。

## 发现与修复过程

反方独立复现并推动实现者修复两项缺陷，详见 [反方记录](g3-cooperation-skeptic.md)：

- **S1：取消泄漏 pending RPC 槽位。** SDK 在取消后不一定发送 response，旧逻辑只靠 response 释放计数，连续取消会耗尽槽位。永久回归执行 20 次取消后再 ping/call，当前通过。
- **S2：协议触发 shutdown 后子进程不退出。** 仅 pause stdin 会留下存活句柄。永久回归验证重复 pending id、协议超载、EOF、SIGTERM 都有界退出，当前通过。

已发现的 S1/S2 均有永久回归，本批没有悬而未决的失败用例；未实现的扩展场景列在下方，不据此宣称不存在所有竞态。

独立 QA 是在修复后将这些反例纳入永久测试并执行通过；不伪称自己先运行过旧版失败。另一次早期全包尝试发生在 server/stdio 文件尚未落盘时，client 6 条通过而协议入口超时；产物齐备后重跑通过，未将该准备时序问题误报为业务故障。

## 限制与后续关卡

本批没有验证所有协议版本、v2 无握手模式、真实 Claude MCP 配置加载、模型工具选择、实际模型回信或浏览器视觉。没有重跑先前 G3 真实模型尝试；G3 仍不放行。

原设计中的部分扩展场景（如全部版本协商分支、每类业务错误全集、真实 owner 重启后的 MCP 恢复）不应由这 20 条测试泛化为全部覆盖。取消测试的“已保存回复丢失”采用 fake owner，真实 SQLite 幂等另由隔离接线验证；它不是本批新的真实进程 crash/commit 组合实测。

现在可以确认：工具能被所测协议客户端发现并调用，消息沿现有身份规则入库，失败与取消不会擅自换身份或自动重发。**工具成功不等于模型执行成功，更不保证自动回应。**
