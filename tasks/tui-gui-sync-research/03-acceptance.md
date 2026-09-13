# 受控发送边界与验收矩阵

2026-09-09，独立 subagent `sync_acceptance_research` 只读结论。根代理整理；未执行测试。

## 不能从现有信号推导的结论

- `frontend/src/terminal/connection.ts:76` 的 sent 只是 ws.send 未抛异常。
- `packages/terminal-protocol/src/index.ts:27` 通用 input 没有 prompt requestId/语义回执；quiet 只代表输出安静。
- 当前 hook 身份和事件名无法独自关联 GUI 请求；时间接近、正文相同、PTY 回显均不够。
- daemon instance fencing 不等于跨客户端仲裁，也不等于同一 PTY 原生会话不会切换。

## Happier 的启发式边界

下列路径前缀：`research/third-party/happier/apps/cli/src/backends/claude/unifiedTerminal/`。

- `ownComposerDraftGuard.ts:73–101` 给出草稿、未知样式、权限/信任/编辑器/选择框等阻止原因；`:106–135` 清理后重捕获说明检查和操作之间仍有竞态。
- `createClaudeUnifiedPromptInjector.test.ts:620` 明确有 capture_failed / generating 可继续的测试；实现 `createClaudeUnifiedPromptInjector.ts:239,250` 并非对所有未知状态阻塞，in-flight steer 也可跳过 guard。首版不要继承该放宽策略。
- `createClaudeUnifiedInputArbiter.ts:174,895,1116` 区分时间、注入与接受证据；已写入消息不能当成未送达重排。
- `createClaudeUnifiedPromptInjector.test.ts:6,42,78,108` 分别测多行、CR/CRLF、大文本、控制字节；多行测试不带 bracketed-paste markers。不能把某种粘贴封装当作所有适配器的统一实现。

## 验收矩阵

| 场景 | 必须看到的结果 |
| --- | --- |
| 双标签同时发送 | 明确顺序或一方拒绝，不拼接，同 requestId 不二次写 |
| TUI 半截草稿 + GUI 发送 | 原草稿不变，GUI 正文保留，不写 |
| 最后检查后立即出现键盘输入 | 可协调输入使旧尝试失效或按确定策略串行，不混成一次提交 |
| 写前断连 | 不写、不显示已接受；重试重新核验目标 |
| 写后或 Enter 后断连 | 不确定、同请求不重发；迟到原生证据可更新 |
| 网关重启 | 不把已有尝试当作新任务执行；状态缺失时诚实报不确定 |
| PTY/原生会话/generation 变化 | 旧目标拒绝，旧回执不落到新会话 |
| 多行、CRLF、中文、长文本 | 正文语义保留，仅提交一次；超限/控制字节写前拒绝 |
| 权限、信任、菜单、设置框 | 不粘贴、不按 Enter 确认选项 |
| 屏幕读取失败/过期/未知 | 不写，说明原因，保留正文 |
| 同文多发或 TUI 同文输入 | 不用正文相等直接合并请求确认 |
| 写入后长期没收到原生消息 | 不靠超时宣称成功，不无限重发 |

首轮只交付已验证适配器的普通空闲输入框、单条受控提交。不自动清除自身残留，不做运行中 steer 或权限审批。若目标存在绕过本 daemon 的其他输入，必须有额外 host 协调能力才能开放发送，无需扩成 OS 全局输入锁。

可复用基础测试：`frontend/tests/terminal-client.test.ts:18`（输出重放/实例）、`backend/tests/terminal-transport.test.ts:12`（发送失败隔离）、`packages/terminal-daemon/tests/owner.test.ts:10`（多网关）、`packages/ai-session-bridge/tests/bridge.test.ts:62`（旧 generation）。它们都不是发送安全验收的替代。

真实 Claude 验收至少覆盖双标签、TUI 草稿、多行、权限框、写后断连；合成 PTY 和 parser fixture 不能替代真实 CLI 界面证据。
