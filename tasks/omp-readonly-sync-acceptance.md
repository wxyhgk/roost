# omp 可靠只读同步：实现与验收

日期：2026-09-09。本文件是当前契约；早期阶段记录中的未实现清单以这里为准。

后续 transcript 接入已实现，消息覆盖范围及新增前端契约以 [omp transcript 接入说明](omp-transcript-implementation.md) 为准；本文的 OSC 回放契约仍有效。

## 已完成

- 使用 omp v18.1.11 做真实验证。独立 worktree：
  /tmp/diy-omp-readonly-sync，分支 exp/omp-readonly-sync。
  运行数据、HTTP 端口和 daemon 都隔离；日常 daemon 未被重启。
  业务修改仍位于原工作区，保留了其他人员的未提交修改；该 worktree 用作 omp 的隔离工作目录。
- runtime 给结构化事件附上产生时的 PTY instance。daemon 单独保存带 sourceSeq 的事件日志，
  即使没有 HTTP 客户端也继续记录。日志每实例最多 4096 条、8 MiB。
- IPC hello 增量声明 agent-event-replay-v1。readAgentEvents(sessionId, instanceId, afterSeq)
  返回 events/cursor/highWater/hasGap/more；通常每页最多 256 KiB，
  大于页预算的单条事件独立返回（单条上限 1 MiB，低于 IPC 上限）。
- CLI 尚未识别时不消费来源游标；识别后从日志补收首条 session_start。
- 消息及消费游标同一 SQLite 记录原子提交。sourceSeq 去重不依赖展示缓存；
  写入失败不推进消费游标。多网关陈旧写入被乐观版本校验拒绝，而不是覆盖；
  数据库唯一索引保护 (cliId,nativeSessionId)。这不等同支持多活网关同步所有内存视图。
- 旧 daemon 无需替换仍可提供实时通知；sync.replaySupported=false 明确不能补收。
- session 删除清理注册表和来源日志；PTY 替换不会自动复用旧绑定。

## 前端契约

保留原 GET/POST /api/ai-sessions/:id，新增：

POST /api/ai-sessions/:id/rebind
body:
{terminalInstanceId,cliId,nativeSessionId,expectedGeneration,expectedRevision}

成功：{binding}。必须由当前 PTY 的近期来源日志证明所请求 nativeSessionId。
版本不一致、身份未确认、旧 daemon 无日志能力均返回 409，不盲目换绑。
换绑原子创建新 generation、清空旧展示缓存并从新原生会话的日志边界补收，
旧 WebSocket 以 1008 关闭。此接口不归档旧 generation 的展示缓存。
新 generation 不接受旧 generation 的 cursor；前端保存 (generation,seq)，不要只保存 seq。

GET /api/ai-sessions/:id?afterSeq=0&generation=...
返回 {binding,generation,events,cursor,hasGap,sync}。

WS /api/ai-sessions/:id/events?afterSeq=0&generation=...
- 首帧 ai-session-snapshot：同样携带 binding/generation/events/cursor/hasGap/sync。
- 增量 ai-session-event：携带 generation/seq/binding/event。
- ai-session-sync：仅在诊断变化时推送 {generation,sync}，最多每秒检查一次；
  不推进消息游标。用于显示日志故障、缺口和不可达，不必等重连才知道。
- generation 不匹配时升级前返回 409，未知绑定 404，非法游标 400。
- 已换绑的会话，afterSeq>0 必须附 generation；首次拉取可用 afterSeq=0。
- 客户端发送数据会关闭；没有 GUI 输入或权限批准接口。

sync:
{replaySupported,hasGap,lastReceivedAt,lastError,hasMessages}

hasMessages 表示已实际观测到消息正文；并非宣称 provider 支持完整 transcript。
source_unavailable 表示来源读取/持久化失败，needs_rebind 表示发现其他原生身份，
daemon_unavailable 表示 daemon 连接不可用。缺口不能靠重连凭空恢复。

## 验收证据

1. 实际 omp 发出三条通知：session_start、prompt_submit、stop，全部有原生 session ID。
   query 为 “Reply with exactly ROOST_SYNC_OK.”，response 为 “ROOST_SYNC_OK”。
2. 真实跨进程测试：先关闭 HTTP，再经隔离 daemon 启动 omp。
   omp 完成后重启 HTTP，收到两条 user/assistant 消息；WebSocket 同样收到两条。
3. 第二次 SIGKILL HTTP 再启动，SQLite 恢复仍只有两条消息；PTY PID 和 instanceId 保持不变。
4. 测试覆盖分页、淘汰缺口、日志写入失败、重复补收、落库并发冲突、
   等待 CLI 识别、换绑版本冲突、旧 generation、旧 daemon 能力兼容与普通 PTY 回归。
5. 真实权限弹窗没有在此轮人工触发；等待/解除状态由协议测试覆盖，不声称真实权限联调已完成。

可复现真实验证（会调用一次配置好的模型，但禁用工具/扩展/规则）：

ROOST_VERIFY_OMP=1 ROOST_OMP_WORKTREE=/tmp/diy-omp-readonly-sync \
node --import tsx --test backend/tests/omp-live.test.ts

可选 ROOST_OMP_BINARY 指定 omp 可执行文件。常规测试跳过此用例，避免自动调用模型。
该测试使用现有模型凭据完成请求，不打印凭据，不导入旧聊天。

## 发布与剩余边界

日常服务尚未部署新 daemon。新增补收能力需要新 owner 进程，
升级会结束旧 PTY，应在用户结束当前会话后的维护窗口进行。
HTTP 可以先使用旧 owner，但那时只提供实时通知，不能宣称断线可补收。

日志是有界的，daemon/机器断电或磁盘不可写不能保证无限历史；
磁盘错误期间同一 owner 会报告 unavailable，成功重试后标记来源缺口。
本轮不提供完整 transcript 对账、token 流、GUI 写入、自动权限处理或其他 CLI 的验收保证。

## 本次验证计数

- backend：108 通过，1 个真实 omp 用例默认跳过；该真实用例另行显式执行并通过。
- terminal-daemon：4 通过。
- ai-session-bridge：5 通过。
- workspace-store：24 通过。
- terminal-runtime：43 通过；terminal-protocol：16 通过；core-server：5 通过。
- backend、terminal-runtime、terminal-protocol、terminal-daemon、workspace-store 类型检查通过。
- 包边界与 git diff --check 通过。
- 未执行前端构建/浏览器验收，未升级日常服务。

## 日常环境上线检查（后续推进）

只读检查确认日常 HTTP 8787 可访问 /api/ai-sessions。
daemon PID 40917 未声明 agent-event-replay-v1，7 个终端仍活跃：
3 个 omp、1 个 Claude、1 个 Qwen，以及 2 个未识别 CLI 的 shell。
这些是检查时的快照，不是以后操作时可复用的 PID 清单。

新增上线诊断：
- npm run daemon:status：直接检查当前 owner 能力，列出 id/cli/pid/instanceId 与数量。
  不读取终端正文、不创建 daemon、不改 session。
- GET /api/diagnostics：schemaVersion、gateway PID/启动时间、daemon 连接与补收能力、
  存活终端数量，以及 AI 绑定/离线/缺口/错误数量。
  diagnostics 是新源码接口，未在本轮重启 HTTP 来宣称其已上线；
  daemon:status 已在日常环境只读验证。
- daemon 不可达时 liveSessionCount=null，与连接正常但数量为 0 明确区分。

验证：后端 110 项通过，1 项真实 omp 用例默认跳过；新增只读诊断测试通过，
类型检查、包边界和 diff 检查通过。

升级选择已询问用户：保留当前终端待维护窗口，或明确允许结束 7 个终端后升级。
在收到结束会话的明确选择前，不执行 daemon stop，不自动把短暂无响应当作需要替换 owner。
