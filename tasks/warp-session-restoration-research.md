# Warp 会话注册、持久化与恢复调研

日期：2026-09-08
范围：`research/third-party/warp`（只读源码调研）

## 结论

Warp 将“会话身份/布局”“终端运行态”“AI 对话”分层保存，通过 ID 关联。恢复时先恢复可持久化的 UI 与历史，再按运行环境校验是否可以重建 shell；不会把旧 PTY 当作仍然存活的进程。这个分层适合本项目的 `workspace-store`、`terminal-runtime`、`ai-session-bridge` 演进。

## 关键证据

### 稳定 ID

`crates/warp_core/src/session_id.rs` 的 `SessionId(u64)` 是强类型、可序列化的标识；每个 bootstrapped subshell（包括 SSH）各有一个 ID。ID 不包含 cwd、shell 等易变信息，因此恢复时应把环境字段单独校验。

### 持久化模型

`crates/persistence/src/model.rs` 的 `TerminalPane` 保存 pane UUID、cwd、shell launch data、输入配置、关联 conversation IDs 和 active conversation ID。终端 pane 与 AI conversation 分开建模，用 ID 连接，而不是把 transcript 塞进 pane。

AI conversation 持久化了 `last_event_sequence`（用于恢复事件投递游标），并通过 `is_restorable`/`tasks_are_restorable` 检查任务树是否有明确 root；模糊或损坏的任务结构会被拒绝恢复。旧字段使用 serde default，保证历史数据库兼容。

### 恢复判定

`crates/integration/src/test/session_restoration.rs` 覆盖：多 tab、cwd 被删除、多个 shell、不同 host/shell 的 blocks、后台输出、notebook/workflow/code/settings pane。删除 cwd 的测试要求应用不崩溃并回退到 `~`；不同 host/shell 的历史不会混入当前 session；后台输出按原顺序恢复。

这些测试说明恢复不是简单“读回快照”：要验证 cwd、shell、host 等上下文，无法验证时降级为安全默认状态，并保留可显示的历史内容。

## 对本项目的可借鉴设计

1. 新建 `session-registry`（或扩展现有 bridge），作为 session 生命周期唯一 owner；HTTP、daemon、AI bridge 只通过 registry 查找，不各自维护 session 真相。
2. 持久化 `webSessionId`、terminal pane/instance ID、native CLI session ID、cwd、shell、cliId、lastEventSeq、状态和更新时间；PTY pid 等运行态只作重新绑定候选，不能作为永久身份。
3. daemon 重启后按 instance 是否仍存在、cwd 是否存在、shell/CLI 是否一致分级恢复；不满足条件时建立新 PTY，并把旧绑定标为 `offline`，避免误写入新终端。
4. 事件采用单调 cursor；恢复连接携带 `afterSeq`，从持久化游标补发。事件日志与快照分开，快照保存当前状态，日志用于短期断线恢复。
5. 每次恢复必须幂等：重复启动不创建重复 pane/binding；未知或损坏的 native session 只显示历史，不注入输入。

## 建议验收测试

- 已有快照 + cwd 删除：服务启动成功，状态为 degraded/offline，不崩溃。
- shell/host 不一致：历史可读，但不加入当前 shell history。
- daemon 重启：同一 web session 恢复到同一 native ID；instance 更换时要求重新绑定。
- 事件游标：重连补发未确认事件，重复连接不重复交付。
- 损坏 AI 任务树：拒绝恢复运行态，保留可读摘要。

## 限制

本目录是 Warp 源码快照，未运行其完整 Rust 集成测试；上述测试证据来自源码中的测试定义和断言。Warp 的桌面 pane 模型不能直接复制到我们的 Web/PTY 架构，应借鉴分层持久化、恢复校验和游标语义。
