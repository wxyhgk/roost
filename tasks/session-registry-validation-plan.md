# Session Registry 验证计划

## 目标

验证将 workspace session、PTY instance、CLI 原生 session 和事件 cursor 统一到 registry 后，能在 daemon/gateway 重启、多客户端订阅和实例替换场景下保持一致。测试应复用现有 `backend/tests` 的 node:test、FakePty、真实 HTTP/WS 进程测试风格。

## 最小测试矩阵

| 场景 | 验证内容 | 最小断言 | 测试层 |
|---|---|---|---|
| 首次绑定 | 三个 ID 建立一条 registry 记录 | 返回稳定 binding；`list/get` 可读 | package unit |
| 幂等绑定 | 相同三元组重复绑定 | 不新增记录，更新时间/版本语义明确 | package unit |
| 冲突绑定 | 同一 web session 换 terminal/native ID | 返回冲突；旧绑定仍有效 | package unit + HTTP |
| 原生 session 重复 | 一个 native session 被两个 web session 绑定 | 拒绝第二个绑定，避免 GUI 分叉 | package unit |
| 实例替换 | 相同 web session 出现新 PTY instance | 旧事件不混入新实例；cursor 从新实例起算 | runtime integration |
| 事件发布 | user/assistant/tool/state 事件进入 registry | 单调递增 seq，订阅者按顺序收到 | package unit |
| 事件去重 | 相同 eventId 重复投递 | 只出现一次，不推进第二个 seq | package unit |
| 断线补发 | 客户端带 `afterSeq` 重连 | 只收到缺失事件；无重复/遗漏 | HTTP + WS |
| cursor 过期 | 请求早于 ring buffer 保留范围的 cursor | 返回 gap 标记和可重新同步的 snapshot | package unit + WS |
| 多客户端 | 两个客户端不同 cursor 同时订阅 | 各自从 cursor 继续，后续事件 seq 相同 | WS integration |
| 订阅退出 | 一个客户端断开 | 其他订阅者继续；无监听器泄漏 | WS integration |
| daemon 重启 | 只重启 gateway，PTY daemon 保持 | instanceId/pid 不变，registry 可重新绑定 | existing daemon-restart |
| daemon 重启 | daemon 与 gateway 都重启 | 持久记录可恢复；旧 instance 标为 offline，不能误复用 | process integration |
| 数据库恢复 | registry snapshot 写入后异常退出 | 最后一条完整记录可读，不出现半写 JSON/半事务 | store integration |
| 工作目录变化 | 恢复时 cwd 不存在或不一致 | 仅恢复元数据，拒绝自动注入旧输入 | integration |
| shell/CLI 变化 | shell 或 cliId 与快照不一致 | 标记 needs_rebind，不发送旧会话事件 | integration |
| 删除会话 | workspace session 删除 | registry、订阅和恢复索引一并清理 | HTTP + store |
| 权限/错误 | 未绑定 session、非法 cursor、超大事件 | 稳定 HTTP code；不泄露 transcript 内容 | HTTP |

## 推荐测试文件

- `packages/session-registry/tests/registry.test.ts`：绑定、冲突、去重、cursor、ring buffer。
- `backend/tests/session-registry.test.ts`：HTTP/WS 契约和多客户端订阅。
- `backend/tests/session-registry-restart.test.ts`：真实 gateway/daemon 生命周期，基于 `daemon-restart.test.ts` 扩展。
- `packages/workspace-store/tests/session-registry-store.test.ts`：事务、快照恢复、旧 schema 升级。

## 验收门槛

1. `npm test -w packages/session-registry` 和 `npm test -w backend` 全绿。
2. 每个 WS 客户端断线重连后，事件序列满足“无重复、无遗漏”；若 cursor 已过期，必须显式 `gap=true`。
3. gateway 单独重启不能改变 PTY `pid`/`instanceId`；daemon 重启后旧实例不得被静默冒充为新实例。
4. 任意恢复失败必须是可观察状态（`offline`/`needs_rebind`），不能自动向错误 CLI 注入输入。
5. 测试使用 fake clock 或固定事件序列，避免依赖 sleep；真实进程测试只覆盖跨进程边界。

## 实施顺序

先完成内存 registry 单元测试，再接 HTTP/WS；随后增加 SQLite 快照与恢复，最后加入真实 daemon 双进程重启测试。每一步都保留现有 `/api/pty` replay 测试作为回归门槛。
