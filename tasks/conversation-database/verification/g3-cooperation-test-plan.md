# MCP Agent 通讯：独立无模型验收计划

状态：**首轮已实施并完成无模型验收。** 冻结 SDK v1 1.30.0、zod 4.5.4 和 initialize 兼容路线；新增 19 条新包测试与 1 条真实隔离 daemon 接线测试。实际结果、缺陷修复与未覆盖范围见 [独立测试报告](g3-cooperation-tests.md)。下文保留原设计矩阵，不能将整张矩阵泛称已经全部通过；没有调用模型，G3 真实协作仍不放行。

## 实施前只读核查的基础（历史盘点）

| 源码或测试 | 现有能力 | MCP 接入时须保留或补齐 |
|---|---|---|
| [agent-message.mjs](../../../scripts/agent-message.mjs) | context/send/inbox/outbox；从 env 获取 socket/terminal/instance/token；业务请求双 pin；send 正文 15 KiB、IPC 请求 32 KiB、响应 4 MiB、5 秒超时；stdout 单 JSON、错误 stderr、token 脱敏 | 当前是一次性 CLI，不是 MCP server；错误最终转为 Error.message，状态/code 不能靠 JSON 字符串猜测恢复；没有 AbortSignal 取消契约 |
| [owner.ts](../../../packages/terminal-daemon/src/owner.ts) | 四个 peer RPC 校验运行中 terminal/instance 和 token，身份由 owner 决定 | MCP 参数不能指定 socket/token/terminal 或任意 sender 来覆盖该认证边界 |
| [peer-delivery.ts](../../../packages/terminal-daemon/src/peer-delivery.ts) | context 返回 conversationId/runId；inbox/send 要求 expectedConversationId/expectedRunId；漂移报 sender_changed，缺 pin 报 sender_pin_required | MCP 不得每次发送前静默刷新身份再重发；否则同一个任务会换发件人 |
| [peer-ipc.test.ts](../../../packages/terminal-daemon/tests/peer-ipc.test.ts) | 两项已有真实隔离 Unix socket、PTY、真实脚本/SQLite 测试，包含错误 token、同 instance 换 native、旧 instance、幂等 | 可复用夹具结构；其 synthetic omp 识别/手工 binding 仅用于无模型接线测试，不能计作真实 CLI 自动识别证明 |
| package.json / package-lock.json | 本次检索没有 @modelcontextprotocol 依赖或现有 MCP server/client 测试 | 尚无可直接复用的 SDK 版本、stdio harness 或冻结的协议兼容基线 |

这轮只读取了上述文件和官方协议资料，没有安装依赖、启动日常服务或读取私人原生日志。上一阶段报告中关于权限源码复核的归属已按主负责人要求修正为：反方独立核查权限分支，主负责人据此收敛约束并核对产物。

## 协议选择依据与本轮冻结结果

官方 TypeScript SDK 主仓当前把 v2 标为稳定线，拆分为 `@modelcontextprotocol/server`、`@modelcontextprotocol/client`，对应 2026-07-28 规范；v1 是仍维护的兼容线。本项目没有既有 SDK 约束，建议使用官方 SDK，但安装前锁定实际发行版本和目标客户端兼容范围，不从 main 分支示例推断本机 Claude 已支持全部新能力。[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)

| 协议基线 | 无模型协议断言 |
|---|---|
| 旧客户端兼容（例如 2025-11-25） | initialize 版本/能力协商 → notifications/initialized → tools/list → tools/call；不支持的版本按冻结契约协商或拒绝；初始化请求不可导致业务发送。[旧版生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) |
| 2026-07-28 原生模式（仅在本轮明确支持时） | 每请求 `_meta` 中版本/客户端能力；与旧 initialize 的兼容路径分开测试，不能要求新原生模式必须先旧握手；检查新版结果形状。[新版传输与兼容说明](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)、[新版 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) |

两套模式都要检查 stdio 的 UTF-8 JSONL 帧完整性、stdout 只能含协议消息、日志走 stderr。仅文档描述不能代替对实际 SDK 和目标客户端的兼容验收。[stdio 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

本轮已冻结 SDK v1 1.30.0，并用 2025-11-25 initialize 路线完成黑盒测试；没有扩大到 v2 新版范围。SDK 互操作通过不代表 Claude 已发现或调用该工具。

## 已冻结的应用工具契约

正式名称为 agent_context、agent_inbox、agent_outbox、agent_send，均已实现；下表保留逻辑简称。成功返回 content 文本与 structuredContent；业务错误返回 isError=true 和 error.code/message/status。

| 逻辑工具 | 输入与输出要点 |
|---|---|
| context | 空对象，拒绝未知字段；返回当前 conversationId/runId，不返回 token、socket 或任意可选身份 |
| inbox | 明确双 pin，cursor/limit 可选；只列当前被认证会话收件箱；返回实际游标与分页数据 |
| send | 明确双 pin、recipientId、稳定业务 requestId、text，可选 inReplyTo；返回实际持久 message/delivery，queued 仍是 queued，不能命名为“已执行” |
| outbox（若首轮包括） | 与 inbox 相同身份约束，不因已有 CLI 支持就擅自扩大 MCP 首轮范围 |

JSON-RPC request id 与业务 requestId 是两层标识：RPC 断开后可以换新的 JSON-RPC id，但原信重试必须保持同一业务 requestId/正文/发送身份。当前 peer IPC 没有 cancelDelivery 方法；MCP 请求取消只结束等待，不能隐式承诺撤回已持久信件。

必须冻结业务错误的稳定 code/status 载体，以及非法工具名/协议参数错误与工具执行错误的区分。现有脚本只输出 message 这一点应作为适配契约问题处理，不能在测试中默认已经提供结构化 code。[工具调用与错误模型](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

## 三层夹具：都不调用模型

1. **stdio 黑盒子进程 + fake Unix owner。** 启动真实 MCP 可执行入口，测试端发送原始 JSONL，并独立检查每个 stdout 帧；fake owner 可控制 hello、错 request id、分片、超长响应、超时、断开与取消竞态。不得把一个 fake tool callback 当成真实 stdio 验收。
2. **官方 SDK client 互操作。** 使用已冻结版本的真实 stdio client 调 list/call，与原始 JSONL harness 分开，避免双方复用同一自制解析器造成假通过。这里只验证客户端与服务器协议互通。
3. **真实隔离 owner + SQLite + PTY + MCP 子进程。** 延用现有 peer-ipc 夹具，临时目录和 socket，合成绑定，接收方 writer 不启用。验证 MCP→IPC→真实 store 状态；读写身份来自本测试 PTY 的自身 env，临时私有凭证文件模式 0600，测试结果不得输出其内容。断言新增 aiCommands=0，说明此阶段只入信箱，没有模型执行。

每个夹具都有最终清理：关闭 stdin，给子进程有限退出窗口，必要时仅终止本测试子进程；销毁 socket/timer，停止隔离 owner，清除测试目录。所有等待有界，禁止启动日常 daemon 或杀全局 Claude 进程。stdio 结束时的进程生命周期按选定 SDK 契约核验。[stdio 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)

## 原设计用例矩阵（实际覆盖以结果报告为准）

| 组别 | 可执行场景 | 必须观察的证据 |
|---|---|---|
| 初始化与列表 | 正常握手/新版协商、版本不兼容、重复 init、未完成旧握手直接 call、tools/list 空 cursor/非法 cursor、未知工具 | 与冻结协议一致；未授权阶段 send 入库数 0；工具 schema 无 credential/terminal/socket 字段，不假报未实现能力 |
| 基本调用 | context → pinned send → B pinned inbox；多行文本、emoji；可选 outbox | 真实 messageId 在两端一致、sender 为 owner 认证身份、状态真实、无额外 PTY command |
| RPC 与幂等 | 相同业务 requestId 相同内容但不同 JSON-RPC id；同 key 改内容；不同 MCP 子进程重试 | 前者同 messageId，改内容冲突；不能用 MCP request id 自动生成新的业务 key |
| 原生身份漂移 | context 后，同一 PTY instance 从 native A 换成 B；同 conversation 换 run；owner 重启旧 run | 旧 pins 返回稳定 sender_changed 或约定失效码、inbox 数不增；显式重新 context 后才能用新 pins；同 conversation 新 run 的合法旧 key 重试仍保持旧信件 |
| 凭证约束 | 缺 env、错误 token、旧 instance token；tool arguments 夹带 token/socket/terminalId/sender；正文刚好含测试 token | 输入字段被拒或无覆盖效果；stdout/stderr/结果/错误/SDK日志均无 token；stdin 抓包中没有 env 凭证 |
| stdout 与分帧 | 首字节到退出全量捕获；多帧一写、逐字节分片、UTF-8 跨 chunk、通知不带 id、并发乱序回复 | stdout 每个非空行都是可解析 MCP 消息，绝无 banner/Node warning/调试打印；通知不产生伪 response，响应只关联对应 id |
| 错误传播 | owner unavailable、forbidden、sender_changed、invalid_reply、idempotency conflict、未知 recipient；非法 JSON/非法工具参数 | 协议错误和业务工具错误按冻结结构区分；业务 code 不被扁平化丢失；错误响应无 secret/stack/path 泄漏 |
| 大小与数量 | text UTF-8 15 KiB 边界/超一字节；limit 1/100/0/101/小数；请求帧/回复大小超过冻结上限；大量 pending calls | 超限无入库；按字节而非字符限制；pending/timer/socket 有界，不能无限积累；不会截断内容后悄悄发送 |
| 原生提交不确定 | fake owner 已 commit 然后断连接，客户端重试同业务 requestId | 第一请求不得说“没有发送”；重试只有一条信件；不能自动换 key 或重复执行 |
| MCP 子进程故障 | 退出、stdin EOF、SIGTERM、畸形帧后错误、owner 中断 | 有界退出/恢复策略，已持久信件保留；不因 MCP 重启伪造新 owner/run |

## 取消与竞态的明确边界

MCP 的请求取消是停止当前 RPC 工作的机制，不能据此证明持久副作用已撤回。取消通知和结果可能竞态，测试不能要求绝对“取消后永远没结果”；必须验证不额外发送、不泄漏资源以及原业务 key 可用于确认结果。[取消规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)

需要四个可控 barrier：

- **调用 IPC 前取消：** 若实现承诺此时取消可阻止提交，fake owner 收到请求数必须为 0；不承诺时不能伪造这个保证。
- **IPC 已发、尚无回复时取消：** MCP 停止等待并释放 socket/timer；不得自动调用 store cancelDelivery，也不得重新发送。
- **owner 已 commit、回复丢失或刚好取消：** 使用同业务 requestId 查询/重试只得到原信；对用户展示“结果待确认”，不能返回确定未发送。
- **结果后/未知 id/重复取消：** 不能误取消其他并发请求；子进程继续正确处理后续 call。

本批如不支持取消副作用回滚，应明确写为“不支持”，只验证传输取消。不能把 MCP notifications/cancelled 与 HTTP cancelDelivery 混为一个接口。

## SDK 与测试工作量判断

现有持久化和身份逻辑无需为 MCP 重写。主要新增成本在：协议版本/客户端兼容冻结、常驻 stdio 生命周期、结构化错误与取消信号、独立黑盒测试。原一次性 CLI 脚本不能原封不动作为 MCP stdout。实施后 CLI 已复用新包 client，MCP server 独立负责协议包装和结构化错误；业务 CLI 仍按其原有单 JSON/stderr 契约输出。

建议使用官方 SDK 承担协议，再复用受限 IPC client；若首轮选择手写最小协议，也必须承担版本协商、schema、分帧、取消、并发和关闭这些测试成本。此处是实现建议，不代表已安装或已验证 SDK。

最终测试所有权已分配：packages/agent-messaging/tests/** 采用纯 mjs/node --test；packages/terminal-daemon/tests/peer-mcp.test.ts 负责真实隔离接线。独立测试者未修改业务实现。

## 放行条件与仍然不能宣称的内容

首轮无模型放行要求：选定协议模式 initialize/协商/list/call 实证；正确 pin 和漂移拒绝；幂等和结果不确定不重发；stdout 干净、无 credential 输入/输出；超时/超限/取消可终止；真实隔离 IPC 与 SQLite 对齐，且没有原生 AI command。

任一身份静默变化、凭证出现在 stdin/schema/产物、重复入库、取消导致自动重发、stdout 非协议输出、旧会话错误地成功调用均阻塞。SDK 版本或目标协议未冻结也不能宣布互操作完成。

通过后只可说“工具可被协议客户端发现和调用，消息按现有身份规则入库”。真实 Claude 等客户端是否加载 MCP、模型是否选择调用、是否同意自动协作，以及 native receipt/最终 assistant/HTTP/WS 的整链证明，都需要另列后续真实验收，不能拿这批无模型成功替代。
