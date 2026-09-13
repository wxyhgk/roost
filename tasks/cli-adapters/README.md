# 多 CLI 后端适配交接

2026-09-09。此次研究覆盖 Claude Code、Qwen Code、OpenCode、Codex、Gemini CLI、官方 Grok Build、Oh My Pi。CLI 是运行程序；它选择哪个模型供应商，不决定本项目采用哪个适配器。

## 当前交付

| CLI | 对话读取 | 同一个 TUI 的身份关联 | GUI 发送 |
| --- | --- | --- | --- |
| Claude | 既有 JSONL 增量读取 | 既有 daemon 私有 hooks | 保留原有默认关闭、2.1.266 版本限定实现 |
| Qwen | 新增 JSONL 读取、工具/思考、详情、按已知 native ID 唯一发现 | 新增 daemon 作用域启动代理，接原生 protocol 2 事件 | 原生 input-file 通道已实现并实测；可靠回合结束状态仍缺失，产品发送能力暂不开放 |
| OpenCode | 既有有界 API 快照；新增原生 idle/busy/retry/unknown | 新增 1.18.29 普通启动 TUI 插件，按当前 route 自动绑定并跟随切换 | 未开放；API 空闲不证明 TUI 草稿/当前选中会话状态 |
| Codex | 保留既有 rollout 读取 | 普通 TUI 仍缺可信 endpoint + thread 自动关联 | 新增独立原生队列 transport 原语，未接成普通终端可用发送能力 |
| Gemini | 新增有界 JSON 快照，支持同消息修订与耐久详情；新增内置 CLI 识别 | 当前明确绑定文件，自动 hooks 启动尚未接入 | 未开放 |
| Grok Build | 新增真实 ACP updates.jsonl 增量读取、工具、原生 chunk | 当前明确绑定 native ID + 文件 | 未开放；共享 leader 不等于已证明当前 TUI 所选 session |
| omp | 保留既有 OSC 身份 + v3 JSONL | 既有自动身份 | 本轮未增加发送；独立 RPC 不能代替当前 TUI |

“新增读取器”不意味着任意已运行终端立刻自动出现对话；上表单独列明身份入口。发送能力仍以 `GET /api/ai-sessions/:id` 的 `control.supported` 为准，不能从 CLI 名称或有历史正文推导。

## 共用的后端入口

- `packages/ai-transcript/src/registry.ts` 统一选择读取器，backend source 不再维护多份 CLI 白名单。
- 正文继续经过现有 bridge、SQLite 历史、分页与 WebSocket，无新增前端专用对话仓库。
- Qwen 发送复用原有 `/api/ai-sessions/:id/commands`、requestId 幂等、FIFO、revision、取消、uncertain 和 daemon 重启规则。详细契约见 [既有发送交接](../tui-gui-sync-implementation.md)。
- OpenCode `sync.transcript.nativeStatus` 是原生 agent 状态；未知或查询失败返回 unknown，保留已读取正文。状态变化即使没有正文变化也会提交。
- `sync.transcript.coverage`：Claude/Qwen/Codex/omp 为 recorded_supported_entries，OpenCode/Gemini 为 bounded_snapshot，Grok 为 recorded_chunks。Grok 暂未组装完整回合，前端不能把每个 chunk 宣称为完整回答。
- Gemini/Grok 详情走既有耐久 generation history；不回读已经修改或删除的原生文件来拼旧详情。

## Qwen 启用边界

当前启动代理按真正运行的 Qwen **0.23.1**、structured protocol **2** 校验。机器上的 npm package.json 可能仍显示 0.21.14，但 cli-entry 会跳转到自动更新目录，因此不能据包版本宣称兼容。

`ROOST_QWEN_GUI_SEND=1` 是实验通道的配置开关，**不是当前已经可用的产品发送开关**。真实 TUI 结构化流未提供可靠完成事件，当前 launcher 不声明 lifecycleSupported，因此即使设置此变量，control.supported 仍为 false。还要求精确 binding.transcriptPath；没有它就拒绝提交，避免首条 GUI 消息卡在队列。该配置与 `ROOST_CLAUDE_GUI_SEND` 独立；运行时 `scripts/ai-command-control.mjs pause/resume` 暂停/恢复所有已配置的 GUI 发送通道。新代理只作用于该 daemon 新建的 zsh 终端；不修改用户 dotfiles、Qwen settings 或全局 hooks，不热补装旧 Qwen 进程。

独立原生输入测试已证明不通过 PTY 粘贴提交；尚未完成真实多轮队列验收。命令执行器在将来接到已验证生命周期能力后仍会等待原生空闲、权限状态及短暂输入静默，且只有一个在途命令。原生事件与新增 transcript 用户 UUID 共同确认接收；若 TUI 同时提交、原生队列合并文本、超时或证据缺失，则标 uncertain，停止自动重试。Qwen 会 trim 外部文本，因此 API 对有首尾空白的文本返回 invalid_request，避免悄悄改变正文。

Qwen 无路径时仅按已确认 native ID 查找唯一匹配文件，不猜“最近会话”；`ROOST_QWEN_PROJECTS_ROOT` 可指定 projects 根目录。启动事件发生时文件可能尚不存在，后续事件会补报路径。

## 研究与下一步

独立报告：[Qwen](qwen.md)、[OpenCode](opencode.md)、[Codex](codex.md)、[Grok](grok.md)、[Gemini/omp/总体盘点](landscape.md)。各报告记录本机版本、官方资料与测试边界。

OpenCode 普通启动自动身份链已补齐，真实 TUI 切换与网关重连通过。下一步先为 Qwen 找到官方可用的完成状态或终端专属扩展，跑通真实两轮后再开放 control.supported；随后补 Codex 的受控启动身份链，以及 OpenCode 的发送前输入状态与接收证明，再开放发送；Gemini 补当前版本的临时 hooks 加载；Grok 补 shared leader 的同 session 多客户端验收与 chunk 回合组装。没有使用新建隐藏 agent 来假装与现有 TUI 同步。

本轮没有修改前端，也没有重启日常 daemon。测试使用临时数据库、临时进程或模拟服务；真实 CLI 验证范围以各报告为准，不把 fixture 通过等同于真实模型回合通过。

## 最终验证

常规测试共 328 项通过、6 项需显式开启的真实测试跳过，无失败：backend 154 通过 / 4 跳过；terminal-daemon 31 通过 / 2 跳过；ai-transcript 27、cli-adapters 6、workspace-store 42、terminal-runtime 44、terminal-protocol 17、ai-session-bridge 7 全通过。新增 Gemini 内置项时回归发现图标缺失，已补后端 SVG 并重新通过完整 backend 测试。

所有 workspace 类型检查、源码依赖边界和 `git diff --check` 通过。没有执行前端构建或浏览器视觉验收。

另外显式执行的真实验证：Qwen 0.23.1 原生单次输入与同 session transcript 回答通过；Codex 0.153.4 临时 Unix WebSocket server 的原生排队回执通过（合成线程，无模型凭据）；Grok 1.0.13 隔离合成会话产物读取通过；OpenCode 1.18.29 临时 server 的真实 API schema 核查完成。均不等价于这些 CLI 的完整 GUI 双向发送已验收。
