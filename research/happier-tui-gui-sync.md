# Happier：TUI / GUI 同步研究

研究日期：2026-09-07。源码位于 `third-party/happier/`，上游 https://github.com/happier-dev/happier 。
本次检出分支 `dev`，提交 `d06e287b42e7b73a48159c21731d33d95e966801`；这是开发分支快照，不等同于已发布版本能力。
完整工作树已拉取，Git 历史为 depth=1 浅克隆。本轮未安装依赖、运行 Happier 服务或调用模型。

## 已从源码确认

1. **原生会话 ID 单独关联。** `apps/cli/src/backends/claude/localControl/createClaudeSessionTranscriptProjector.ts` 明确区分 Happier sessionId 与 claudeSessionId，并投影 Claude JSONL 消息、工作状态等。我们的网页终端 ID 也不能直接当成 AI 会话 ID。
2. **GUI 消息需要输入协调。** `apps/cli/src/backends/claude/unifiedTerminal/createClaudeUnifiedInputArbiter.ts` 包含注入就绪判断、延期重试、运行中引导、失败交还与提供方接收证据。成功写入终端不等于 Claude 已接收消息。
3. **状态来自 Hook 和会话事件。** `apps/cli/src/backends/claude/unifiedTerminal/createClaudeUnifiedHookLifecycleBridge.ts` 结合原生生命周期、权限请求与 transcript 观测；不是简单用几秒无输出判定完成。
4. **回显去重有独立处理。** `apps/cli/src/backends/claude/unifiedTerminal/bindClaudeUnifiedTerminalSession.ts` 对 GUI 已发送消息和后续 JSONL 回显做关联，避免两份消息；也处理运行中引导消息延迟到回合末尾才出现的情况。
5. **界面细节确实有专用适配。** `apps/cli/src/backends/claude/unifiedTerminal/tuiControls/` 包含权限模式、弹窗、恢复选择、设置守卫等模块。这不是一个通用屏幕转聊天窗口的简单函数。

## 文档声明，尚未本机复现

https://happier.dev/features/terminal/ 区分：OpenCode 双端同时控制；Claude 默认切换控制，启用 unified terminal runtime 后可共享一个原生 TUI；Codex 单方控制。Claude 统一模式默认关闭，使用 tmux 或 bundled zellij。

不要把“支持某 CLI 的 GUI”解读成“该 CLI 已支持原生 TUI 双向共用”。

## 对本项目的建议

保留现有 daemon 托管 PTY；另加 AI 会话桥接层，负责原生会话绑定、结构化 transcript、生命周期和 GUI 输入队列。不要把整个 Happier 服务直接嵌入稳定基座。

首个可验证范围：Claude 左侧原生 TUI，右侧只读结构化对话；接通绑定、增量读取、消息去重与明确的完成/权限事件。之后再接右侧发送消息，并验证输入中、弹窗中和网络重试下不会重复发送或覆盖用户输入。

需要继续验证：适配器依赖范围、native hook 的注入与撤销方式、当前发布版本中的默认开关、是否能用我们已有 PTY 控制端口替代其 multiplexer 依赖，以及真实双端操作测试。

## 2026-09-08 源码追踪结果

本节基于同一固定提交 d06e287b，未更新上游。检查了实现及对应测试源码；仅运行下述纯函数断言，未运行 Happier 全套测试或真实模型会话。

### 1. 启动与绑定：需要掌握启动入口

`apps/cli/src/backends/claude/unifiedTerminal/buildClaudeUnifiedTerminalSpawn.ts` 负责构造实际 Claude 命令与运行环境；`runClaudeUnifiedTerminalSession.ts` 选择 tmux/zellij 等 host adapter，连接输入和生命周期组件。

重要修正：`utils/startHookServer.ts` 文件头仍描述通过 `--settings` 注入 Hook，但当前 `utils/generateHookSettings.ts` 实现已改为临时 `--plugin-dir` 插件，插件内容为 `hooks/hooks.json`。非 Hook 配置仍使用 settings overlay。源码解释是某些外层包装器也传入 settings，导致 Hook 被覆盖；插件目录可以组合。

Hook forwarder 把 session_id 和 transcript_path 等数据传给本地 Hook 服务，从而把“这一启动实例”绑定到 Claude 原生会话。Hook 请求有共享凭据校验逻辑；这里只研究机制，不读取用户凭据。

**对我们意味着**：仅发现进程名是 claude，不足以可靠绑定 GUI。首轮应该提供明确的“以同步模式启动 Claude”入口，生成该次启动专属的插件和标识；在普通 shell 中任意执行的旧 Claude 不能默认宣称已支持双向同步。不要改写用户全局 Claude 配置。

### 2. TUI → GUI：结构化日志与生命周期分开

`utils/sessionScanner.ts` 按已绑定会话跟踪 JSONL，结合文件监听和轮询补偿；处理初始历史、消息去重、会话切换、子代理以及文件缺失。`localControl/createClaudeSessionTranscriptProjector.ts` 把这些记录投影为 GUI 消息及工作状态。

`unifiedTerminal/createClaudeUnifiedHookLifecycleBridge.ts` 处理 SessionStart、UserPromptSubmit、Stop/StopFailure 等证据及权限阻塞，并区分主会话和 sidechain。不能把子代理停止当成整个主会话完成。

**限制**：依赖 CLI 何时落盘；不能承诺 JSONL 的 GUI 展示一定与 TUI 逐 Token 同步。屏幕捕获主要还承担弹窗、草稿和控制确认用途，并非完全不解析屏幕。

### 3. GUI → TUI：写入、提交、接收是不同阶段

`unifiedTerminal/createClaudeUnifiedInputArbiter.ts` 协调 pending 队列、运行中引导、延期重试和提供方接收证据。
`createClaudeUnifiedPromptInjector.ts` 做文本规范化、写入预算和 composer draft guard；检测到用户已有草稿、弹窗、不明确的屏幕状态时延期。

`packages/agents/src/runtime/terminal/inputInjection.ts` 明确区分：

- injected：字节完成注入；并非已完成整轮对话。
- deferred：用户输入、权限阻塞、终端忙、初始化中。
- failed：失败位置包括 before_write、during_write、after_write_before_enter、after_enter_unknown，并携带 duplicateRisk。

对应测试确认：Enter 之后是否提交不明确时，仍保留待接收关联，后续精确接收证据可完成状态转换；不能无条件重发，否则会重复提问。

`bindClaudeUnifiedTerminalSession.ts` 对 GUI 已发送消息与 transcript 回显去重；延迟到回合末才出现在日志里的引导消息也要能关联，不能只使用很短的时间窗口或单纯文本相等。

### 4. GUI 权限确认：请求响应桥接

`localPermissions/localPermissionBridge.ts` 保存 pending permission request，包含请求 ID、工具、创建及到期时间。`utils/startHookServer.ts` 承接权限 Hook HTTP 请求，等待 GUI 决策，再以 Claude Hook 结构返回。

这解释了为何“显示等待确认”和“从 GUI 确认”需要明确的事件来源与请求 ID。HTTP 服务重启期间，原来的待决请求不能假装仍可批准；旧会话/旧实例的迟到回答也不能发给新会话。

### 5. 能否直接作为 npm 包使用

检查 `apps/cli/package.json` 与 `apps/cli/src/lib.ts`：虽然存在库入口，导出的主要是 ApiClient、ApiSessionClient、配置、logger 和 Claude 日志 schema；上述 unifiedTerminal 同步模块并未作为独立公共库导出。

源码通过大量 `@/` 内部引用依赖 Happier 的 session client、pending queue、metadata、provider registry、runtime assets 与终端集成。当前不适合只添加一个依赖就拿来即用。若要复用代码，需要明确抽取范围和兼容版本。

许可证也不能只看包级声明：CLI package 声明 MIT，而 `agent/runtime/terminal/injection/arbiter.ts` 文件头注明来自 generalaction/emdash 的 Apache-2.0 代码；实际复制时应保留对应来源和许可说明。本轮没有复制这些实现到产品中。

### 6. 我们的 daemon 能否替代 tmux/zellij

**可以作为候选，但尚未证明等价。** Happier 当前 `TerminalHostKind` 枚举为 tmux/zellij/windows_console，并非一个现成的 node-pty host。

我们已有 PTY 生命周期、写入、重连与输出重放，可以支撑原生 TUI。缺少的关键能力是：可信的当前屏幕状态、用户草稿检测、输入提交确认，以及 GUI 与原始键盘输入的统一协调。

Happier 的 `packages/agents/src/runtime/terminal/control.ts` 提供屏幕 capture 与文字/特殊键控制接口。我们的历史 snapshot 主要用于恢复显示，不能未经验证就当成当前屏幕证明，尤其浏览器不在线时。

首轮只读 GUI 可以不依赖这些完整控制能力；双向输入之前必须补齐或采用明确的单方控制策略。

### 7. 已检查和执行的验证

阅读的测试包括：

- `unifiedTerminal/createClaudeUnifiedInputArbiter.test.ts`：迟到确认、重复风险、运行中状态保留、消息交还。
- `unifiedTerminal/createClaudeUnifiedPromptInjector.test.ts`：多行输入、CRLF 规范化、控制字节拒绝、写入预算。
- `utils/sessionScanner.incremental.test.ts` 等扫描器测试入口。
- `packages/agents/src/providerSettings/definitions/claudeRemote.test.ts` 与定义：claudeUnifiedTerminalEnabled 默认 false。

直接以 Node 的 TypeScript stripping 导入 Happier 原始 `agent/runtime/terminal/injection/arbiter.ts`，完成 7 项断言：正常就绪、权限阻塞、finalizing、用户近期输入、输出未安静、未初始化超时、running 单独不阻塞。全部通过。

最后一项尤其重要：该底层函数对 running 状态可以返回 ready，上层协调器负责决定排队还是运行中引导。不能单独复制底层函数就认为输入安全已完整实现。这是有限的纯函数验证，不是整个 Happier 同步功能的验证。

## 建议的最小后端路线（尚未实现）

1. **同步启动与身份绑定**：网页终端 id + PTY instanceId + CLI 原生 sessionId，明确维护三者映射；临时插件启动 Claude，并验证 Hook 握手。
2. **只读 GUI 与可靠状态**：增量读取绑定 transcript，输出规范化消息和 tool 事件；基于 Hook 增加 AI running / waiting / completed 状态，沿用当前 terminal activity 的独立含义。
3. **有确认的 GUI 输入**：先仅在已确认可输入时发送；消息 ID、排队、取消、提交不明确和迟到确认必须可观察。暂不支持运行中双端抢输入。
4. **权限应答与真正双向控制**：请求 ID、实例匹配、超时、终端草稿保护、输入仲裁；再做控制权切换或并发输入。

建议单独建设 `packages/ai-session-bridge`；provider 适配与业务编排可更新，稳定 daemon 保持 PTY 基础职责。桥接服务生命周期要单独设计，不能让业务 HTTP 热重载导致挂起的权限 Hook 静默丢失。

第一轮验收：同目录同时开两个 Claude 不串消息；resume/新实例重新绑定；历史重放不变成新回复；子代理完成不误报主会话完成；桥接断线显示不可用但原生 TUI 继续工作。
