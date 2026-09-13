# Happier：同一个 Claude TUI 如何接收 GUI 消息

2026-09-09，独立 subagent `happier_send_research` 只读结论。根代理整理。源码版本 `d06e287b`；未运行 Happier。以下路径前缀为 `research/third-party/happier/apps/cli/src/`。

| 环节 | 已核实的源码与结论 |
| --- | --- |
| 请求去重 | `rpc/handlers/sessionUserMessageSend.ts:49,92`：localId 对应结果 Promise + 请求指纹，同 ID 不同内容拒绝。注册表上限 1000，属于进程内去重，不是跨重启 exactly-once。 |
| 统一入口 | `backends/claude/startup/createClaudeUnifiedUserMessageHandler.ts:11`：进入 enqueueSessionUserMessage，返回 providerAcceptancePending。 |
| 同 TUI 输入 | `integrations/tmux/adapter.ts:178,217,228`：既有 pane 捕获、tmux buffer paste；zellij 在 `integrations/zellij/adapter.ts:1402`。我们已有 node-pty owner，无需因此引入 tmux。 |
| 运行状态仲裁 | `agent/runtime/terminal/injection/arbiter.ts:27`：初始化、权限阻塞、最近输入与 quiet 窗口。800ms 静默只是辅助条件，不是可提交证明。 |
| 草稿/弹窗 | `backends/claude/unifiedTerminal/ownComposerDraftGuard.ts:86,96`：识别非 composer、foreign draft。用户草稿不清除；自身已知残留最多两次清理并重捕获。首版不建议移植自动清理。 |
| 注入 gate | `backends/claude/unifiedTerminal/createClaudeUnifiedPromptInjector.ts:217,250`：控制 gate + draft guard，受阻延期。部分 capture_failed/generating 路径会放行，不能称为严格保证，见报告 03。 |
| Enter 验证 | `integrations/terminalHost/promptSubmitVerification.ts:70,126`：验证 staged，再 Enter，再观察结果。区分 after_write_before_enter、after_enter_unknown。 |
| 接受确认 | `backends/claude/unifiedTerminal/createClaudeUnifiedInputArbiter.ts:889,897`：写成功只是 awaiting_provider_acceptance；`createClaudeUnifiedHookLifecycleBridge.ts:595` 用 prompt/session/prompt ID 关联 hook。 |
| 重试边界 | `backends/claude/unifiedTerminal/injectionFailurePolicy.ts:20`：有 duplicateRisk 不自动重放整条；`createClaudeUnifiedInputArbiter.ts:626` 对相同内容多候选不按 FIFO 猜确认。 |

值得移植的是：一个进程所有者、发送请求标识、注入和接收分阶段、保护用户草稿、写后不确定不盲重发。不是整个终端宿主适配层、复杂 UI 自动导航或第二个 Claude SDK 进程。

屏幕捕获和实际写入不是原子操作。Happier 的屏幕/文本启发式需要按 Claude 版本验证；我们能协调所有本项目输入的 daemon 是更合适的仲裁位置，但仍不能阻止 Claude 自己异步改变界面。
