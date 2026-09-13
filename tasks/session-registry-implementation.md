# 会话注册表：阶段实施记录

当前可靠只读同步契约与真实验收见 [omp-readonly-sync-acceptance.md](./omp-readonly-sync-acceptance.md)。下文按阶段保留历史记录。

日期：2026-09-09

## 本次范围

沿用 `@roost/ai-session-bridge`，不再建立重复 registry 包。
源码核对发现独立恢复入口已在 `packages/core-server` 实现，不能再把它当作待建能力。
普通 PTY replay 与 AI 结构化事件保持分离。

- 每个 AI 会话独立 cursor；以 droppedThrough 判定缺口，不再因其他会话产生事件而误报。
- SQLite 的 ai_session_records 保存绑定、cursor、保留事件和淘汰位置。
- 保存成功后才更新内存和通知订阅者；失败不推进 cursor。
- 从数据库恢复时 binding 显示 offline，不将历史 running 当作进程存活证据。
- 保留窗口内按 eventId 去重；按条数及 JSON 字节数限制事件缓存。
- 绑定幂等；同一 cliId/nativeSessionId 不能绑定两次；不同 CLI 的 native ID 分开。
- GET/POST /api/ai-sessions/:id 使用 URL ID，POST 校验 workspace session、实时 instanceId 与 cliId。
- GET 支持 afterSeq，负数、非整数和超前游标返回 400。
- session 删除同步清理持久化绑定和网关内存绑定。
- 不改前端，不重启现有 daemon。

## HTTP 契约

GET /api/ai-sessions：{sessions: Binding[]}

GET /api/ai-sessions/:id?afterSeq=0：
{binding, events, cursor, hasGap}

POST /api/ai-sessions/:id：
{terminalInstanceId, cliId, nativeSessionId, transcriptPath?}

成功返回 {binding}。错误采用 {error:{code,message}}。
游标属于该绑定；未来换绑必须设计 generation，不能复用旧游标。

## 验证

桥接包 4 项测试通过；SQLite reopen/去重/缺口/实例冲突测试通过；
新增 HTTP 2 项测试通过；后端既有 92 项测试通过。
backend 与 workspace-store 类型检查、包边界检查通过。

store 全套测试出现 1 项失败：并行改动给 workspace snapshot 新增 pinnedSessionIds，
既有 CRUD 测试期望尚未包含该字段。本次未覆盖或回退该改动。

## 尚未实现

- 原生 CLI 自动发现、transcript reader，以及可信生命周期信号接入。
- 恢复绑定的在线重新确认；当前保守显示 offline，重复 bind 不自动改为 ready。
- /api/ai-sessions/:id/events WebSocket 端点目前不存在；旧对话对此端点的说明超出了实现。
- 多网关同时发布的并发控制；当前持久化适配器面向单发布者，不承诺多写者一致性。
- 超过保留窗口的永久去重、完整 transcript 归档。
- PTY 更换后的显式换绑、generation 和旧订阅失效流程。
- 真实 daemon 重启专项验证。本次 SQLite reopen 不能替代该验证。

下一步先接一个 CLI 的可信事件源与实例校验，再补只读 WS；输入/权限代理继续暂缓。

## 第二阶段：只读 WebSocket（2026-09-09）

已实现端点：
`WS /api/ai-sessions/:id/events?afterSeq=0`

1. 首帧：`{type:"ai-session-snapshot",binding,events,cursor,hasGap}`。
   events 是 afterSeq 之后的保留事件；hasGap=true 表示历史已淘汰，不能宣称完整补收。
2. 后续：`{type:"ai-session-event",seq,binding,event}`。
3. 客户端保存 seq 重连；cursor 按会话隔离，非法/超前 cursor 在升级前返回 400，
   未绑定 ID 返回 404，仍复用现有访问检查。
4. 客户端发数据返回 WS 1008（只读），不写 PTY。
5. 每连接待发送内容最多 16 MiB；超限或发送失败断开该连接，不影响其他消费者。
6. 断连解绑订阅，kill 删除会话时关闭相关事件连接。

实现：backend/src/ai-session-stream.ts，路由接入 backend/src/server.ts。
测试覆盖双客户端不同游标、实时事件、重连、gap、只读拒绝、慢消费者和真实业务路由删除清理。

尚未接入 CLI 自动发现/transcript reader，也未提供 GUI 输入和权限代理。
本阶段验证用隔离 HTTP/WS 和合成结构化事件，不代表用户实际 CLI 已产生消息。
第一阶段所列“事件 WebSocket 不存在”已由此阶段完成；其他未完成项仍有效。

## 第三阶段：接入 runtime 的实时 OSC 777 来源（2026-09-09）

实现：backend/src/ai-agent-source.ts。

复用现有 TerminalService 的 agent 事件及协议解析器，不扫描或重放终端屏幕。
订阅所有 workspace session，不依赖前端是否打开终端；新建 session 后立即刷新订阅，
其他生命周期变化以 250ms 周期核对。HTTP server 关闭时释放定时器和订阅。

首次绑定要求：
- runtime 当前已识别 cliId，有存活的 terminalInstanceId；
- 通知包含 native session_id；
- 通知属于已知的生命周期事件。
后续无 session_id 通知仅在本次 collector 已确认身份后接收。
从 SQLite 恢复的 offline 绑定不因 PTY 存活自动转成 ready：
需要新通知再次确认同一原生 ID。不同 native ID 或不同实例不自动换绑。

事件投影：
- session_start → ready
- prompt_submit → running；有 query 时记录 user message
- permission_request / question_asked → waiting
- permission_replied / tool_complete → 仅 waiting 状态解除到 running
- stop → completed；有 response 时记录 assistant message
- stop_failure → failed
- idle_prompt 与未知通知不改变状态

消息与其状态在同一条持久化事件内更新。PTY exit、daemon 不可达、实例/CLI
变化会标记 offline；不会向终端写入命令，也不会批准权限。

新增测试使用真实 runtime OSC parser + fake PTY；
CLI process recognition 在测试中固定为 omp。覆盖屏幕输出不投影、身份门槛、
状态/内容持久化、恢复后重新确认、PTY 替换隔离和迟到通知。
这不是用户真实 omp/Claude/Codex 会话联调结果。

边界：
- 仅支持会主动发送既有 OSC 777 协议的 CLI/插件；未安装插件的 CLI 不会凭空出现消息。
- 只保存通知携带的 query/response，不承诺完整 transcript 或 token 流。
- 通知没有 provider eventId；每次接收生成 UUID，因此不能对 provider 重发做严格去重。
- runtime agent 通知不持久回放，HTTP 离线期间可能漏掉事件；尚无 transcript 对账补全。
- 会话更换仍需未来的显式 rebind/generation 契约。
