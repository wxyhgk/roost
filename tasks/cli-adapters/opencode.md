# OpenCode 后端适配调查与实施

日期：2026-09-09。本机 `opencode --version`：`1.18.29`。

## 用户可以得到什么

正常 daemon zsh 中运行本机 `opencode` 时，受控启动加载进程专属 TUI 插件，通过真正的 `api.route.current` 报告当前选中的原生会话。已有明确绑定的 OpenCode server/native session 时，右侧继续读取同一会话的正文、推理与工具记录，并且能区分原生 `busy` / `retry` / `idle` 状态。读取状态失败不会让已经可读的对话消失。缺少状态条目或未知结构记 `unknown`。

这次没有把 OpenCode 标为可从 GUI 自动发送。虽然已有当前 TUI 会话身份，发送前仍未实现草稿检查与原子提交保障；仅凭 idle 发送会违反已经给 Claude 建立的 TUI 输入优先约定。

## 现有代码与本次改动

- `packages/ai-transcript/src/opencode.ts`：继续读取显式 endpoint 的最多 100 条消息、累计响应 4 MiB、5 秒超时、保留稳定 message ID 和内容修订；添加 `/session/status` 读取，结果放 `checkpoint.state.nativeStatus`。
- 状态仅变化时不伪造新的 transcript，不重放旧正文，`reset=false`、`bytesRead=0`。消费方需要比较 checkpoint 中的状态后更新 bridge；不能只靠 bytesRead 判断是否有变化。
- `packages/ai-transcript/src/opencode-control.ts`：集中 server session identity 校验；提供精确原生 user message 收据匹配。message ID、session ID、role、正文和 parts 必须匹配，synthetic/ignored/非文本内容不当成普通用户输入的确认。
- 保留 server 创建时间、目录、project ID、endpoint 构成的 identity；相同 native ID 在替换后的 endpoint 上不能直接继承旧记录。
- 不增加独立隐藏 agent，不发送猜测按键，不修改前端、用户全局配置或日常 daemon。
- `packages/terminal-daemon/src/opencode-launch.ts`：`installOpenCodeLaunch(bin, runtimeDir)` 创建局部 wrapper/TUI config/plugin，使用同一 TUI 所拥有的 loopback server。插件每 250ms 读取真实 route，切换先报告旧身份 SessionEnd，再报告新身份 SessionStart，回到首页标记 offline 并保留历史绑定；busy/idle/permission/question 仅读取当前选中 session。
- 仅启用已检查的 1.18.29。已有 `OPENCODE_TUI_CONFIG`、`--pure`、`--mini`、非 loopback hostname 及 `run`/`serve`/`attach` 等独立子命令保留原行为，不自动宣称被此 TUI 观察器覆盖。help/version 无插件。动态端口由 wrapper 分配，也支持显式 `--port`。

## 核实到的原生能力

官方 [Server 文档](https://opencode.ai/docs/server/) 说明 TUI 本身连接一个 server，可使用固定 hostname/port 连接现有进程；另跑 `serve` 是另一个 server，因此不能以它冒充当前 TUI。该文档列出 session/message、async prompt 和 SSE API。

本机临时 `opencode serve --pure --hostname 127.0.0.1 --port 41987` 的 `/doc` 实际核实了：

| 能力 | 本机接口 | 后端使用边界 |
| --- | --- | --- |
| 同一原生会话详情 | `GET /session/{sessionID}` | 验证身份，不从最近会话推测 |
| 会话运行状态 | `GET /session/status` | 是 agent 状态，不是 composer 状态 |
| 等待权限、问题 | `GET /permission`、`GET /question` | 可按 session ID 识别待处理项，不自动批准 |
| 原生发送 | `POST /session/{sessionID}/prompt_async` | 支持客户端 messageID，204 不能证明已持久接收 |
| 精确消息读取 | `GET /session/{sessionID}/message/{messageID}` | 后续可用于收据验证与断线对账 |

临时 server 已停止。此操作仅检查原生 schema，没有创建会话、运行模型或发送用户任务。

## 受控启动与身份契约

只接受明确的 `endpoint + directory + nativeSessionId + terminalInstanceId` 组合，并继续使用本项目的 generation 防止过期操作。候选启动方式是 `opencode --hostname 127.0.0.1 --port P --session EXACT`，或 `opencode attach URL --session EXACT --dir ROOT`。必须验证其连接的 server 和真实 session，不能直接把命令参数当成永久证据。

`--continue` / `--fork` 的身份以 TUI 实际 route 为准；不能仅从启动参数猜原生 ID。正常手工运行仍可使用 TUI，但不会自动宣称 GUI 可写。

官方 [Plugins 文档](https://opencode.ai/docs/plugins/) 的服务端事件不能证明哪个 attach TUI 当前选中了该 session。本次进一步核查了本机二进制与官方源码，确认了独立的正式 TUI API，可读取当前 route、选中 session 的状态并注册销毁回调；因此自动身份使用 TUI plugin，不用服务端事件猜测。endpoint 由受控 wrapper 明确设置。

源码基准：官方仓库 HEAD `830d5eb5354874105cc31599635a80c1662609e8`，临时只读 checkout `/tmp/diy-opencode-source`。关键依据：

- [TUI plugin 接口](https://github.com/anomalyco/opencode/blob/830d5eb5354874105cc31599635a80c1662609e8/packages/plugin/src/tui.ts)：`route.current`、`state.session`、`lifecycle.onDispose`。
- [TUI 配置合并](https://github.com/anomalyco/opencode/blob/830d5eb5354874105cc31599635a80c1662609e8/packages/opencode/src/config/tui.ts)：全局 → OPENCODE_TUI_CONFIG → 项目 → .opencode 分层 mergeDeep，plugin origins 累加；添加本地 plugin 不替换原主题、快捷键或其他插件。本机 bundle 同样含此装载顺序。

推荐后续实现顺序：

1. 常规启动的自动身份已实现；后续单独支持已有远端/attach server，不能扫描端口和最近数据库会话。
2. 当前选中 session 已通过正式 TUI API 取得；发送前仍需要草稿状态、对话框状态与输入 epoch。若版本不支持则保持只读。
3. 再连接现有 durable command ledger；持久化客户端 message ID 后发原生 prompt_async，收到精确原生 user message 后标 accepted，网络不确定时只对账不自动重发。
4. 两个真实 TUI、切换 session、半截草稿、权限弹窗、网关断线、daemon 重启和重复 requestId 联合验收后再开放 GUI 发送。

不使用 `/tui/append-prompt` 加 `/tui/submit-prompt` 替代第 2 步：这些控制接口未提供本项目需要的当前草稿比较与提交事务语义。

## 验证

`node --import tsx --test packages/ai-transcript/tests/opencode.test.ts backend/tests/opencode-transcript-source.test.ts`：6 项通过。覆盖可变 snapshot、identity 不匹配、响应上限、状态独立变化、状态失败保留正文、严格收据匹配和现有 bridge 消费。

`node --import tsx --test packages/terminal-daemon/tests/opencode-launch.test.ts`：覆盖 wrapper 配置/参数/端口/旁路，以及 TUI 当前 route 的选中、切换、回首页、权限状态和 IPC hello/分片 reply 确认。真实 daemon/TUI 自动绑定联调由主代理统一验收。

证据层级：本机版本及真实 OpenAPI schema 已验证；HTTP/解析/bridge 为本地服务 fixture 测试；没有宣称已经完成真实 OpenCode TUI/GUI 双向发送验收。


## 自动绑定真实验收与生效方式

`ROOST_VERIFY_OPENCODE=1 node --import tsx --test backend/tests/opencode-live.test.ts` 已通过：隔离 daemon 中启动真实 OpenCode 1.18.29，在同一个 TUI server 创建两个空测试会话；没有 HTTP 网关时选中第一条，身份仍进入 daemon journal；连接网关后自动绑定；TUI 切换第二条后自动换绑；更换网关后仍恢复同一原生 ID，且同 server transcript reader 进入 transcript 模式。没有运行模型请求；两个测试会话、测试 PTY 和临时目录均清理。

本轮 backend 154 项通过 / 5 项可选真实测试默认跳过；daemon 34 项通过 / 2 项默认跳过。backend/daemon 类型检查、源码边界及 diff 检查通过。

生效需要新版 daemon 创建的新 zsh 终端，再正常运行 `opencode`。已经运行的 daemon、shell 和 OpenCode 不会热安装此插件，本轮未重启日常 daemon。进入或创建原生会话后自动绑定；仍停留在首页、尚未选择会话时没有 native ID，不伪造空会话。

## 2026-09-11：完成提示接入改为接口能力检查

本机升级到 1.18.30 后，wrapper、TUI observer 和 daemon receiver 原来的 1.18.29 门槛使完成状态无法到达网页。已删除 OpenCode 版本白名单及启动时的 `--version` 探测，覆盖上文旧的版本限制。TUI observer 只检查 `route.current`、`session.get/status/permission/question` 和 `lifecycle.onDispose` 等实际接口；缺少必要接口则停止观察，不推断完成状态，也不影响 CLI 自身运行。

事件使用独立的 `protocolVersion: 1`，描述我们自己的通信格式，与 OpenCode 产品版本无关。daemon 验证该协议、事件字段、本机 endpoint 和终端凭据；保留无 protocolVersion 的旧观察器消息兼容，不再校验 OpenCode 版本。接口兼容的 OpenCode 升级只需重新启动 CLI，无需因版本号变化修改或重启 daemon。

验证覆盖当前版本、虚构未来版本和不提供版本信息的 TUI、必要接口缺失、禁止启动版本探测、旧格式兼容和未知协议拒绝，以及前端完成提醒与状态。真实 1.18.30 的隔离 daemon 联调覆盖 TUI 身份、会话切换、gateway 替换和 `prompt_submit → stop` 入库；测试创建两个临时会话并执行本地 `sleep 1`，不发模型请求，结束后删除测试会话。初始空会话没有 status 条目，因此不把打开空会话当成任务完成。前端提示音仍只在后台会话观察到新的 `done` 转移时触发，首次快照和重复完成事件不响；此验证不等于浏览器实际发声验证。

日常 daemon PID 99679 尚未重启，仍有 4 个现存终端。仅刷新网页或重启 HTTP 后端不会升级它的事件接收器；需要重启 daemon 后重新打开 OpenCode，才能应用此次修复。重启会中断现存 PTY 进程，已保存的对话记录与收藏不受影响。

已有自定义 OPENCODE_TUI_CONFIG、pure/mini/attach 模式等旁路范围见上文；为 native server 配置 Basic Auth 的场景尚未接凭据传递，不能把密码写入 transcript URL。GUI 自动发送仍未开放。
