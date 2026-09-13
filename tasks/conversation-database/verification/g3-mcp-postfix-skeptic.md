# G3 MCP 修后验收：独立反方

日期：2026-09-09。状态：**修后第一次真实验收通过；限定后端 MCP 闭环放行**。

独占本报告；只读代码/受控产物，不改业务或测试、不运行模型、不读取凭证与私人会话。保留前轮两次失败，使用新标签，最多两次，真实模型拒绝即停止。

## 必须保留的真实断言

相同 daemon 单 writer 与自动 binding；三真实 CLI 加载四 MCP 工具；B 用户任务与 A seed 加两次 peer，共四逻辑输入；A2/B2/C0。两跳 messageId、inReplyTo、source/run/native UUID 对齐，正文唯一；模型实际 context/inbox/send 的 tool_use 与唯一成功 tool_result，B 从 accepted 原信 ancestry 回信；A 最后 assistant 从回信 ancestry 产生。HTTP assistant 与 native ID 对齐、WS 从原 snapshot 补收 accepted revision；所有 owned PTY/Claude/MCP wrapper/server 退出。建议被禁用不能变成忽略真实草稿，原 inputEpoch 门禁不变。

## 草稿、忙碌、断线、重复覆盖盘点

已只读核对当前测试，以下是代码覆盖范围，不能冒充本轮真实运行：

| 边界 | 当前证据层级 |
| --- | --- |
| 真实草稿与 working 阻挡 | `ai-command-owner.test.ts` 以 fake PTY 屏幕/事件验证两者都不写，Stop 后 FIFO 才写；没有删改保守屏幕规则 |
| epoch 与误回执 | 同测试验证用户输入提高 epoch 后，旧 GUI command 不能因相同文本原生行被误标 accepted |
| 重复与 lost receipt | owner 重复 enqueue 保持 uncertain 且单次写；peer coordinator 缺 command/丢 receipt 与 owner 替换不重投；跨进程 SIGKILL fake-native 边界另有测试 |
| MCP 双 pin/幂等 | `peer-mcp.test.ts` 用真实隔离 stdio、Unix socket、PTY、SQLite 校验同 key 同信封和旧 pin/token 拒绝；native CLI 识别是合成前置，未调用模型 |
| WebSocket 补收 | `peer-messages.test.ts` 验证 snapshot 后连接前消息与连接后消息不漏不重，gateway replacement cursor 要求 resync；这不是实际 CLI 忙碌时浏览器断网重连实证 |
| MCP 等待中断 | 包测试验证取消/超时只停止等待，不伪造撤回或新 key 重投；长期取消槽位和 shutdown 回归已补 |

修后真实主路径与上述无模型故障覆盖应分别报告。若只真实主路径通过，不声称所有故障场景都经过真实模型/浏览器测试。


## 修后第一次真实产物独立复核

已读取 `/tmp/g3-mcp-postfix-attempt1-result.json` 与同前缀日志。日志 3 passed / 0 failed / 0 skipped，result success=true，实际模型 claude-sonnet-5，CLI 2.1.266。只用了本轮第一次，没有第二次模型调用。

- 三 CLI discoveryBeforeModel=true；B bootstrap accepted/acknowledged/idleBeforeSeed=true，保留对应 user/assistant native UUID。
- A→B 原信 `8a64c180-1ad3-40e4-b668-dfc115c19048`，native receipt `e87e0cd1-96b2-4d73-b450-67693178750c`；B→A 回信 `7fedbb1e-cbdc-4316-9603-795c55ad5b24`，native receipt `ea5b7d49-35b2-44a5-938b-56e84380d3cc`。两者 accepted revision 3，回信 inReplyTo 精确等于原信，sender/recipient 对调，run 与 pin 对应。
- 两封 partial exactReceiptVerified/sendToolVerified 均为 true；回信 peerAncestryVerified=true。原信没有 inReplyTo，其 peerAncestryVerified=false 是不适用，不是缺失回信因果。
- executionScope 记录 A 仅 context/send，B 仅 context/inbox/send，各一次 send；唯一 native tool_use/result 对应同信封，B 已读取 accepted 原信。没有 builtin 或额外工具。
- A 最终 assistant `71408e9f-6ecf-48f9-a23c-d371b3789fc3` 为合成任务 FINAL 400，HTTP 同一 UUID/role/text hash；B HTTP assistant 为 `b925c61b-8e22-4d1e-8e4f-66d686095112`。已审测试要求这两条各自从 peer receipt 沿完整 native parentUuid 链追溯，实际运行通过该断言；保留产物是脱敏摘要，没有宣称本人重读了已清理的完整原生文件。
- WS A/B 从事前 snapshot cursor 分别补收 39/46 条 change，匹配对应 delivery 的 accepted revision 3，重复 seq 断言通过。
- inputCommands A=2/B=2/C=0，cUnchanged=true；12 个 owned PID 全部 alive:false，cleanupRequiredIntervention=[]。

## 最终独立裁定

**限定放行修后后端 MCP A→B→A 闭环。** 范围为 Claude Code 2.1.266 / 实际 claude-sonnet-5 / 本次明确用户任务与四 MCP 工具 / 受控启动关闭预测建议。前轮失败原样保留，此次是新授权的新标签成功结果。

这是一次真实完整主路径通过，不是统计意义的稳定性证明。草稿、忙碌、重复与断线故障目前主要由上表无模型边界测试支撑，不能改称这些全部在真实 CLI 或浏览器做过故障注入。其他 CLI、任意任务自动协作、前端视觉与首次登录仍不在本轮放行范围内。

## 新增 gateway 故障回归独立复核

已完整读取并亲自运行 `backend/tests/peer-messages-resilience.test.ts`，**2 passed / 0 failed**，没有模型调用。

第一项使用实际 HTTP server 关闭/重开、新的 SQLite connection，保持同一 coordinator 和实际 command owner 存活。busy 时不写，gateway 关闭期间设置合成 LOCAL_DRAFT 后仍不写；新 gateway 同 requestId 返回原 message/delivery，run 不变；清空合成草稿后仅一次 bracketed-paste 写入，匹配合成 hook+JSONL 原生 UUID 后 accepted，后续重试仍一个信封/command/写入。

第二项在真实 WS 已看到消息且 command owner 已写后关闭 gateway，旧 WS 1012。gateway 离线时由实际 command owner 匹配测试生成的 hook+JSONL receipt 并落库 accepted。新 gateway 对旧 cursor 返回 409 resync_required；新 snapshot 恢复相同 native UUID，重试不写第二次。snapshot→subscribe 间新增消息可以补收，后续 live cancellation 可经 WS/changes 读取，seq 不重复，最终写入仍一次。

真实层：HTTP/WS/SQLite、gateway 生命周期、coordinator、command owner 和回执匹配代码。合成层：CLI runtime/live、屏幕、原生写入记录、hook 与 JSONL receipt；binding 也由测试建立。它验证 gateway 故障契约，**不是自动 binding 的真实模型断线测试，也不是浏览器界面测试**。结合本轮真实主路径，可保留前述限定放行；没有新增未解决阻塞。
