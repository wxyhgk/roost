# Claude / Codex / OpenCode 后端 transcript 接入

2026-09-09。本轮只改后端，未重启日常 daemon，未读取私人聊天或修改全局 CLI 配置。

## 可用入口与边界

复用 `POST /api/ai-sessions/:id`，提供 `terminalInstanceId`、`cliId`、`nativeSessionId`、`transcriptPath`。现有路由校验终端实例与 CLI；读取器再次验证来源中的原生身份。不存在按 cwd、最近修改时间猜当前会话的逻辑。

| CLI | transcriptPath | 当前能力 | 尚不支持 |
| --- | --- | --- | --- |
| claude | 已知主会话 JSONL 绝对路径 | 增量正文、工具、已记录思考、耐久详情；zsh 普通命令自动报告身份 | 已启动旧进程无缝补装、非 zsh 自动加载、子代理完整树、compact 完整语义 |
| codex | 明确 thread 的 rollout JSONL 绝对路径 | 只读 response_item、工具关联、过滤 event_msg 镜像 | 任意 TUI 自动身份发现、隐藏推理、回滚/压缩活动分支重建 |
| opencode | 当前 TUI 的 HTTP server URL，可带 directory 查询参数 | 同 session ID 的有界消息快照、同 message 更新、耐久详情 | 自动 server 发现、SSE、鉴权配置、完整历史回补 |

OpenCode 每轮最多 100 条、合计 4 MiB、5 秒；每秒有界轮询。不能以新开另一个 server 代替正在使用的 TUI。若窗口达到 100 条或含未知 part，报告 partial；即使不足 100 条，coverage 仍是 bounded_snapshot，不宣称完整历史。

Claude / Codex 每轮增量 256 KiB（另有固定大小 header / tail 校验），1 MiB 单行上限；超限/未知格式降级，不转发 provider 私有负载。持久化正文和 checkpoint 同事务提交。消息修订通过稳定 eventId 更新当前快照；历史保留正文修订，分页使用者不能误认为每行都是独立逻辑消息。

## Claude 自动启动集成（默认 zsh 路径）

新 daemon 给自己管理的 zsh 提供临时启动目录，逐段加载原用户启动文件后，把只包含 `claude` 的启动代理加到 PATH。直接输入 `claude` 时加载私有插件；参数原样传递，保留原 Claude 可执行文件及已有插件参数。用户的全局 dotfiles 和 Claude settings 不修改。绝对路径调用、主动覆盖 PATH/自定义函数及 alias 可绕过代理；非 zsh 暂不自动加载。

SessionStart / UserPromptSubmit / Stop 把会话 ID、transcript 路径、事件名经 daemon Unix socket 上报，带终端 ID、instance 和私有校验 token。daemon 校验当前实例后写既有 agent journal，再广播给网关，因此没有浏览器、网关重启也能补收与自动绑定。这里不新增权限批准功能。hook 无 stdout/控制决策，失败不阻断 Claude；实际 Claude 的 hook 没有控制终端，不能用 `/dev/tty` 上报。

`--help` / `--version` 不加载观察器；CLI 内部再调用 Claude 不重复自动注入。以 `--agent` 启动及子代理事件目前不自动采集，避免把子代理身份绑为主会话。插件临时目录在 daemon 退出时清理，初始化失败降级成普通终端。

生效需要更新 daemon 并重新创建终端实例；已有 shell 与 Claude 不会热补装。本轮未重启日常 daemon。前端不需新增调用，复用现有自动绑定与 transcript API。

## Claude 可选 HTTP 观察器（兼容旧手动入口）

`POST /api/ai-sessions/:id/claude-observer` 要求已有 live terminal，创建权限受限临时插件目录，返回：

```json
{"terminalInstanceId":"...","command":"claude","args":["--plugin-dir","/private/..."],"scope":"next_launch","restartRequiredAfterGatewayRestart":true}
```

这是下一次启动参数；后端不会自动执行命令或替换正在运行的 CLI。客户端将参数用于该终端的下一次 Claude 启动。服务端私有脚本通过 loopback 调用 `POST /api/ai-sessions/:id/claude-hook`，token 不进入返回体、日志或前端。

hook 只接收 SessionStart / UserPromptSubmit / Stop 的 session_id 与 transcript_path，验证 token 与当前终端实例。只允许首次绑定或同一身份刷新路径；没有连续日志游标的 hook 不能触发已有身份的自动换绑。失败不影响 Claude 控制决策。网关重启后注册失效，需要重新配置并启动；不修改用户全局 hooks。

此 HTTP 入口仍是手动兼容接口；日常 zsh 自动集成使用上面的 daemon 通道，不依赖此 HTTP token。

## 前端契约

- 原有 GET snapshot / WS replacement snapshot / generation history API 继续复用。
- `sync.transcript.mode` 新增 `unavailable`，没有结构化数据源时不伪称有 OSC 回退；omp 保留原有 osc 模式。
- `sync.transcript.adapter` 标识适配器；coverage 为 recorded_supported_entries 或 bounded_snapshot。
- legacy `/transcript/:eventId` 使用统一 provider detail dispatcher；OpenCode 应使用耐久 `/generations/:generation/messages/:messageId`，不支持重读 legacy 文件详情。
- 显式绑定不代表已证明此 native identity 属于任意当前 TUI；选定 ID / 来源由调用者提供，后端验证数据身份一致，不能替代可靠启动证据。

## 前一轮读取器验证

前一轮集中测试 25 项通过（全部 reader、各 source 集成、Claude hook/observer HTTP），bridge 7 项通过，backend typecheck 通过。当时 Claude / Codex 只执行版本或帮助检查；Claude 后续真实启动验证见下一节。OpenCode 是隔离 mock HTTP 服务测试，没有启动另一个 server 后假称与日常 TUI 相同。

详细单适配器说明见 `codex-transcript-adapter.md`、`opencode-transcript-adapter.md`。


## 本轮真实验证

本机 Claude 2.1.266：在隔离 daemon/PTY 中只输入 `claude`，插件报告身份和 transcriptPath；无网关时事件仍入日志，启动网关后自动出现 Claude binding；替换网关后保留同一个 Claude 进程/instance 与 native identity。未提交模型提示，因此未验证实际回答正文、权限交互或子代理。

复现：`ROOST_VERIFY_CLAUDE=1 node --import tsx --test backend/tests/claude-live.test.ts`。默认跳过真实 CLI 测试。启动代理测试另外验证了原配置加载、带空格参数、版本命令、hook 输出为空、错误 token/未知事件/旧实例拒绝。

本轮回归：backend 149 项通过、2 项默认跳过；terminal-runtime 44 项通过；terminal-daemon 7 项通过；单独开启真实 Claude 测试 1 项通过。三处类型检查与 workspace boundaries 均通过。

官方 hooks 协议依据：[Claude Code hooks reference](https://code.claude.com/docs/en/hooks)，使用 SessionStart / UserPromptSubmit / Stop 的 session_id 与 transcript_path，不输出控制决策。
