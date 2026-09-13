# Happier / Warp 后端设计调研

日期：2026-09-08

## 结论

两者都把终端会话当作后端拥有的长期对象，UI 只是订阅者。Happier 强在把原生 CLI 会话、transcript、hook 生命周期和权限请求绑定起来；Warp 强在统一 session registry、事件队列合并和持久化恢复。我们应先吸收“稳定 ID 绑定 + 单调游标事件流 + SQLite 快照恢复”三项，暂缓完整权限代理、命令重放和复杂终端状态持久化。

## 对比

| 能力 | Happier | Warp | 我们的第一阶段 |
|---|---|---|---|
| 原生 CLI 会话绑定 | 读取 Claude `session_id`，独立于产品 session；支持 transcript 重新发现和 rebind | AI conversation 与 terminal pane 通过持久 ID 关联 | 增加显式 bind；校验 `webSessionId`、`terminalInstanceId`、`cliId`、`nativeSessionId`，禁止冲突绑定 |
| transcript 增量 | 监听 JSONL，历史基线 + fs.watch，轮询兜底，事件去重 | conversation/block 模型持久化，恢复时按快照重建 | 先做 adapter 产出的结构化事件和单调 `seq`，保存最近游标；暂不直接解析所有 CLI 文件 |
| 输入/权限 | 输入 arbiter 有队列、ready/quiet 检查、重试和 provider acceptance；权限 hook 等待 UI 决策 | 终端事件队列集中处理，避免 UI 直接驱动 PTY | 只读同步优先；GUI 写入必须经过后端队列。权限先记录 pending 状态，不自动批准 |
| 断线/重启 | scanner 重新发现 session，绑定 native session，继续投影 transcript | SQLite 恢复 pane/session，校验 cwd、host、shell，后台输出可恢复 | bridge 绑定落 SQLite；重启后仅在 instance/cwd/cli 校验通过时恢复，否则标记 offline |
| 高频输出 | projector 与事件去重，避免重复消息 | listener 合并连续唤醒/输出事件 | ring buffer + cursor，订阅者断线用 `afterSeq` 补发，并限制缓存大小 |

## 适合现在做

1. `session-registry`（可先复用 `ai-session-bridge` 的 API）：SQLite 保存绑定和 lifecycle snapshot。
2. 统一事件 envelope：`sessionId`, `seq`, `eventId`, `type`, `occurredAt`，重复 `eventId` 不重复投递。
3. 重启恢复流程：读取快照，检查终端实例仍属于当前 daemon；不满足条件则返回 `offline`，不复用旧 PTY。
4. 为一个 CLI（建议 Claude）实现原生 session discovery adapter，adapter 只负责发现和增量转换，registry 负责生命周期。
5. 只读 WebSocket replay：连接时先发 snapshot/cursor，再推送后续事件。

## 暂不做

- 一开始同时实现 Claude、Codex、OpenCode、Grok 的 provider 特化。
- 直接把任意 CLI 的终端滚屏解析成“可靠消息”；无结构化来源时只保留 PTY 输出。
- GUI 直接注入 PTY、自动回车或自动批准权限。Happier 的 readiness、确认和重试规则应先移植测试再开放写入。
- 持久化完整终端 grid、光标和滚屏历史；这会把 Warp 的渲染模型带入后端，当前 replay 已足够恢复连接。
- 以 cwd 或标题作为恢复身份。恢复必须依赖稳定 ID，并校验 instance/CLI 上下文。

## 验收建议

- 老 daemon 重启后，绑定记录仍在，正确实例可恢复，错误实例显示 offline。
- 同一个 native session 不能绑定两个网页 session；重复 bind 幂等。
- 订阅断开后用 `afterSeq` 能补齐事件；超出 ring buffer 明确返回 gap，前端重新拉 snapshot。
- 模拟 transcript 重复写入、文件 watcher 重复通知、CLI 退出/重启，事件不会重复或错绑。
- provider adapter 缺失时，普通 TUI 仍正常工作，GUI 显示未连接结构化会话。

## 参考源码

- Happier：`research/third-party/happier/apps/cli/src/backends/claude/`、`utils/sessionScanner.ts`、`localControl/createClaudeSessionTranscriptProjector.ts`、`createClaudeUnifiedInputArbiter.ts`。
- Warp：`research/third-party/warp/crates/warp_terminal/src/event_listener.rs`、`crates/integration/src/test/session_restoration.rs`、`crates/persistence/src/model.rs`。
