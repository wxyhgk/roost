# G3 gateway 故障集成回归

2026-09-09。独立测试 lane，仅新增 `backend/tests/peer-messages-resilience.test.ts` 与本报告，未修改业务代码。

## 覆盖缺口

现有 `peer-delivery.test.ts` 已覆盖 busy/draft/dialog、提交边界不确定、旧 owner 不重发和 run fencing；`peer-messages.test.ts` 已覆盖 HTTP 幂等、同一 gateway 的变化补收及旧 epoch 拒绝。`daemon-restart.test.ts` 验证独立 HTTP 进程退出后真实 PTY 保活，但没有把持久信件与对话 stream 一起串联。

本批补两个组合场景：

1. HTTP 保存信件后，实际 command owner 的 busy guard 保持 queued；关闭 gateway、关闭其 SQLite 连接，保留同一投递 owner。离线时改为模拟 TUI 草稿，仍不写入；重新创建 gateway 和 SQLite 连接，同 requestId 重试返回同一 message/delivery/run。清空模拟草稿后只有一次实际 command-owner 提交，经匹配的模拟原生回执达到 accepted；再次 HTTP 重试不新增信件或 command。
2. 信件已经被 command owner 写出，但还没有接收回执时关闭 HTTP/WS。旧 stream 以 1012 关闭；gateway 离线期间补入模拟 hook 与原生记录，由实际 command owner 核验后落库 accepted。新 gateway 拒绝旧 cursor，snapshot 恢复准确消息与接收 ID；snapshot 和重新订阅之间保存的新消息能补收，之后的取消事件能通过 WS 和 changes API 读取，序号无重复，且不产生第二次原生提交。

## 实际执行与模拟边界

| 部分 | 本批使用的对象 |
| --- | --- |
| HTTP | 真实 `createBackendServer`，本地临时端口，实际 fetch |
| WebSocket | 真实 ws 连接、关闭、重新订阅与变化帧 |
| SQLite | 临时目录真实数据库；owner 与每代 gateway 使用独立连接 |
| 业务调度 | 真实 `createPeerDeliveryOwner` |
| 唯一写入者及接收核验 | 真实 `createAiCommandOwner`，包含屏幕解析、hook、offset、UUID 和精确文本核验 |
| CLI 运行状态 | 模拟 live session 与输出屏幕；没有启动真实 Claude |
| 原生写入 | runtime 写函数作为有界 oracle，记录真正 command owner 发出的 bracketed-paste 正文 |
| 原生接收 | 测试生成的 UserPromptSubmit hook 与临时 JSONL user 记录，不是真实模型/CLI 回执 |
| gateway 重建方式 | 同测试进程内关闭再创建 server 实例，不是 OS 进程 SIGKILL |

因此本批证明 HTTP/WS/持久队列/实际 command owner 组合在 gateway 重建时的行为，**不证明真实 CLI、真实模型、浏览器渲染或跨进程 SIGKILL 的新结果**。已有独立进程测试的证据边界不因本批扩张。

## 执行结果

```sh
node --import tsx --experimental-test-module-mocks --test \
  backend/tests/peer-messages-resilience.test.ts
```

新增专项：**2/2 通过，0 跳过**。

```sh
node --import tsx --experimental-test-module-mocks --test \
  backend/tests/peer-messages.test.ts \
  backend/tests/peer-messages-resilience.test.ts \
  packages/terminal-daemon/tests/peer-delivery.test.ts
```

相关组合：**18/18 通过，0 跳过**。backend 类型检查、`git diff --check` 通过。

首次运行发现的是测试自身两处问题，均已修正：command owner 定时异步 pump 可能已在运行，单次 await pump 不等于已完成回执对账，改为有界等待持久结果；变化事件的 entityId 是 message ID、delivery ID 位于 payload，断言已按接口实际契约更正。没有据此修改生产状态机。

未操作日常 daemon、真实模型、前端、认证或私人对话。完整 backend gate 由集成负责人协调 QA 统一运行；此报告只记录本 lane 的专项与相关组合结果。
