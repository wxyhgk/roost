# G3 后续：标准通讯工具入口

日期：2026-09-09。状态：MCP 通讯工具入口已完成实施与无模型独立验收。G3 真实自动协作关卡仍未放行；本批完成可复用工具入口，没有重复前轮模型尝试。

## 取舍

[Claude 调研](12-cli-cooperation-claude.md)确认已有原生跨会话功能，不能再以“CLI 不支持”概括。原生 inbox 对外消息帧、ACK 与持久消息 UUID 的完整契约仍待核验；Channels 通知本身也不能替代接收回执。直接替换现有 writer 会扩大未经验证的范围。

因此本批把已存在的 context/send/inbox/outbox 包装成 MCP stdio 工具。使用者可以让 CLI 按工具名称和参数 schema 发信、查收件箱，减少模型审查陌生 Bash 脚本和拼装命令的成本。它提供跨 CLI 可复用的工具接口，不能保证模型愿意执行任务，也不负责唤醒目标；目标唤醒与原生接收继续使用现有 daemon 路径。

Happier 对照见 [源码研究](13-happier-cooperation.md)。借鉴其会话工具入口，不复制将跨会话请求降成普通用户输入的身份语义，不另开 SDK 执行器替代原 TUI。

## 模块与责任

| 模块 | 内容 | 负责人 |
| --- | --- | --- |
| `packages/agent-messaging/src/client.mjs` | 有界 daemon IPC、可信终端身份、错误与取消 | conversation_store_impl |
| `packages/agent-messaging/src/server.mjs`、`stdio.mjs` | 四个 MCP 工具及 stdio 生命周期 | conversation_store_impl |
| 新包测试、daemon MCP 集成测试 | SDK 客户端/真实 socket、幂等与换绑反例 | database_test_review |
| [反方审查](verification/g3-cooperation-skeptic.md) | 长进程身份、超时与凭证等反例 | qwen_adapter |
| Claude/Happier 调研 | 官方入口、来源、可借鉴与不能直接复制部分 | conversation_runs_impl / conversation_api_impl |
| 旧 helper、依赖锁、边界与交付 | 共享传输接线、串行安装与汇总 | 主 Agent |

前端、生产数据库及日常 daemon 均不在本批修改范围。

## 契约

- 工具名称：`agent_context`、`agent_send`、`agent_inbox`、`agent_outbox`。
- 非 context 调用始终显式携带 `expectedConversationId` 与 `expectedRunId`，由 daemon 再次核验。MCP 长进程不缓存后自动刷新 sender。
- `requestId` 由调用者提供并在同次重试中保持。工具成功表示本次 IPC 获得结果；具体 delivered/queued/uncertain 含义沿用原信箱契约。
- 不接受工具参数中的 socket/token/senderKind。凭证只从父进程环境进入请求，不在工具描述、输出或错误中回显。
- 取消或超时不等同撤销已保存信封；不自动重试，不建立新的 native writer。
- `scripts/agent-message.mjs` 复用同一 client，保留既有命令行参数与 JSON/错误输出，避免两份传输逻辑漂移。

选择官方 SDK v1 1.30.0 的 initialize/JSONL 接口以形成明确兼容基线，锁定 zod 4.5.4；已核验 npm 同时发布 SDK v2 2.0.0，故不把 v1 说成 SDK 最新主版本。新包明确边界，不强迫 daemon 或业务 HTTP 加载 MCP SDK。安装使用 `npm install --ignore-scripts`，没有运行依赖生命周期脚本。

实现采用官方低层 `Server` 注册工具、Zod 严格校验与官方 stdio transport，使参数错误和业务错误统一保留 `{error:{code,message,status?}}`，并在 MCP 结果中设置 `isError`。`tools/call` 在初始化完成前不触发 IPC。终端环境在 MCP server 创建时冻结；最多八个在途 IPC、十六个待响应协议请求，stdin 缓冲上限 64 KiB。正文、IPC 请求和响应分别限 15 KiB、32 KiB、4 MiB。

使用配置、参数与行为见 [包说明](../../packages/agent-messaging/README.md)。配置文件写可执行文件、参数及必要的环境变量符号引用，不写实际凭证；不自动更改日常 CLI 设置或打开原生发送开关。

## 验收与后续

本批验证协议、身份与持久信箱接线，测试方案见 [独立 QA](verification/g3-cooperation-test-plan.md)，实际结果见 [测试报告](verification/g3-cooperation-tests.md)。模拟 daemon 与实际隔离 daemon 的证据分别记录；模拟绑定不算真实模型识别。

| 最终检查 | 实际结果 |
| --- | --- |
| 新包测试 | 19 通过，涵盖 raw JSONL、官方 SDK client、取消、协议关闭、错误/身份/限额 |
| daemon 完整串行测试 | 47 通过、2 跳过；包含旧脚本 IPC 兼容及新增 MCP→真实隔离 owner/SQLite/PTY 接线 |
| backend 全套 | 167 通过、6 跳过；日志 `/tmp/agent-messaging-backend-final.log` |
| 类型检查 | 新包、daemon、backend 均通过 |
| 其他 | 包边界、`git diff --check`、本目录和新包 README 的本地链接检查通过 |

反方独立发现两项已复测关闭的缺陷：SDK 取消后不发回复，导致协议待响应计数泄漏；协议错误关闭后，暂停 stdin 未让子进程退出。修复分别释放匹配取消请求的计数，以及销毁 stdin 并设置 250ms 退出上限；这只关闭工具进程，不撤销已保存的信。QA 将连续二十次取消后仍可调用、重复 request ID 关闭及 EOF/SIGTERM 退出纳入永久测试。详细反例见 [反方报告](verification/g3-cooperation-skeptic.md)。

只有未来实际 CLI 加载工具、模型真实调用、目标原生接收及显式回信都对应同一 ledger/native ID，才能更新 G3 结论。新工具测试通过不能覆盖旧真实尝试的失败结果。

本批没有把 MCP 自动写入任何日常 CLI 配置，也没有重启 daemon 或开启日常原生发送。下一次真实验证应在隔离 CLI 中加载此包，先确认工具发现和身份，再验证模型真实调用；原生 inbox/channel 的替换仍需单独完成回执契约验证。
