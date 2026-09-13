# 本项目后端：复用点与发送缺口

2026-09-09，独立 subagent `backend_sync_research` 只读结论。根代理整理；没有业务代码改动或本轮真实 CLI 测试。

| 能力 | 当前证据 |
| --- | --- |
| 默认 Claude hook | `packages/terminal-daemon/src/claude-launch.ts:7,16,49`：zsh 局部 wrapper；SessionStart/UserPromptSubmit/Stop；Unix socket 上报。 |
| 实例验证、落日志 | `packages/terminal-daemon/src/owner.ts:16,51,59`：实例 token，journal 先提交后广播。 |
| 顺序补收 | `packages/workspace-store/src/agent-journal.ts:4,26,52`：sourceSeq、highWater、hasGap、more；默认 4096 条/8 MiB。 |
| 原生身份与代 | `packages/ai-session-bridge/src/index.ts:6,64,99`：web/terminal/native identity、generation、CAS rebind。 |
| 身份补收 | `backend/src/ai-agent-source.ts:56,127`：adopt、有序 pump；换代关闭旧 WS。 |
| Claude 正文 | `backend/src/ai-transcript-source.ts:35,40,52`：明确路径增量读取，每秒轮询；`packages/ai-transcript/src/claude.ts:44` 归一化记录，跳过 sidechain/部分事件，不是完整 TUI 状态或 token 流。 |
| GUI 与持久历史 | `backend/src/ai-session-stream.ts:20,23` 只读先订阅后快照；`packages/workspace-store/src/ai-sessions.ts:35` 原子写正文/元数据/replay；历史查询不依赖活终端。 |

## 不可省略的缺口

- `backend/src/server.ts:792,820`：binary / input 都裸写；`:778` 串行仅限单 socket。
- `packages/terminal-daemon/src/client.ts:74`：writeSession 是 notify；owner 仅给 requestId 回错误。`packages/terminal-runtime/src/index.ts:150` 目标缺失可静默无操作。
- `owner.ts:48` 只 fence PTY instance。同一 PTY 中原生身份可切换；`backend/src/ai-identity.ts:11` 有界观察不是与 PTY 写入的原子事务。
- ready/completed 是回合状态，无法证明无草稿、无菜单、无权限框。当前 hook 不报告这些界面状态。
- hook 不传 UserPromptSubmit.prompt。需要 requestId、提交前事件游标、输入 epoch/所有权与原生确认关联；内容哈希本身不能区分同文连发。
- 原生 transcript 历史不能代替 GUI 命令账本；不要把 GUI 待发送文字先作为已接收消息落入原生历史。

## 最小接口建议（未定稿）

GET session 增加 control 能力与禁用原因；POST `/api/ai-sessions/:id/commands`（或 README 的 messages 路径）只支持 submit，携带 requestId、expectedGeneration、terminalInstanceId、nativeSessionId、expectedInputEpoch、text；202 仅表示受理。GET 按 requestId 查持久状态，WS 投影同一记录。

必须新增 daemon 请求响应式 conditional submit，统一协调现有 raw 输入和 GUI 提交。HTTP 预检后调用无回包 writeSession 不满足条件。SQLite 与 PTY 不存在共同原子事务，写后崩溃用 unknown/uncertain，不自动重放。

网关重启可保留同进程；daemon 重启实际结束 PTY。新实例不能自动接续旧发送任务。独立 HTTP observer 是兼容手动入口，其 token 随网关生命周期失效，不应成为默认发送链路。

阶段取舍：先可靠观察与真实多轮对话基线，再验证受控单条提交，最后扩展权限、附件、运行中 steer 与其他 CLI。API 名称和状态词由实施前统一，避免 accepted 同时表示“已受理”和“CLI 已接受”。README 使用 accepted 专指后者。
