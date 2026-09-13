# 有正文时安全自动换绑：P1 实现

日期：2026-09-09。前置能力：[P0 耐久历史](ai-history-implementation.md)。本轮只改后端，没有主动重启日常 daemon。

## 已实现行为

同一 PTY、同一 CLI 的来源日志连续进入另一 nativeSessionId 时，即使已有正文，也可自动建立新 generation。旧代由 P0 存储同事务归档；A→B→A 保留三段绑定关系，复用 A 的原生对话历史。

自动切换要求：

- runtime 支持 `readAgentEvents` 和事件补收能力；桥接存储有耐久 history。
- PTY instance、CLI 与当前绑定匹配。
- 消费边界来源序号连续、日志没有 gap，页游标/类型/实例合法。
- 异步读取后，网页会话仍存在，generation、来源游标和终端身份没有被外部改变。

旧 daemon 无补收能力时，已有正文仍返回 needs_rebind；空绑定的原有自动跟随行为保留。内存桥接或未提供历史存储的自定义 backend，也不会自动丢弃已有正文。

## 来源边界与一致性

自动采集每轮固定第一页的 highWater，最多处理 8 页，只消费到该边界。之后新增事件留待下一轮；不会为追赶不断增长的日志无限循环。同一轮内由自己执行的换绑会更新预期 generation，继续消费；外部换绑/终端替换则停止旧任务。

迟到或重复 sourceSeq 在身份比较前过滤，不会从 B 倒退到旧 A。日志缺口或非法页不跨越失败位置推进来源游标。错误不会因为空轮询被清掉；可靠事件重新被消费后恢复状态。

这证明的是**按日志顺序跟随身份边界**，不是 SQLite 和独立 daemon 的跨进程原子“最新身份”事务。快速 A→B→C 可能短暂经过 B，但不同代的正文不会拼在一起。没有新增 daemon 协议或要求强制升级正在运行的 PTY owner。

## 归档、通知与重试

- 旧代结束、新代建立、当前绑定及来源起点由原有 P0 savepoint/CAS 一起提交。
- 提交失败保留旧代和游标，不发成功换绑通知；故障解除后可重试。
- 提交成功后才调用 onRebound。通知回调异常不会把已提交换绑当作失败再次创建新代。
- 继续以 1008 关闭旧 AI WebSocket；重连 `afterSeq=0` 获得新 generation 快照。没有在旧 socket 上直接改 generation，因此不会留下捕获旧代的状态 monitor。
- bridge 元信息保存上一次 rebind 的原 expectedGeneration/revision 和目标身份。原请求在新消息到达甚至 bridge 重建后重试，仍返回已建立的新代，不再归档一次。若期间又切往第三个身份，旧请求仍为 409。
- 对当前相同身份、正确版本的 rebind 是 no-op，不重新关闭当前 WS。只有最后一次已提交请求支持上述幂等恢复，不提供任意久远操作的全局幂等日志。

## 手工 rebind 加固

`POST /api/ai-sessions/:id/rebind` 保留原 body：terminalInstanceId、cliId、nativeSessionId、expectedGeneration、expectedRevision。

新 `ai-identity.ts` 扫描器从日志起点观察最多 64 页，固定 highWater，严格检查连续序号、实例、无 gap、cursor/more；任一页 highWater 改变即重试错误。读完再查一次空尾，验证来源没有在扫描期间增加记录。所有 await 前后核对连接、CLI 与 PTY。

最终候选是该观察边界内最后一个 nativeSessionId，并记录最后一次进入它的 boundarySeq。只接受明确归属该 ID 的 transcriptPath；换身份会清掉上一候选路径。验证后仍走 bridge 版本 CAS，不依赖用户传入的路径。

新增稳定 HTTP 错误 code（状态均为 409）：

| code | 意义 |
| --- | --- |
| source_gap | 来源不连续或页结构无法证明顺序 |
| source_changed | 扫描期间来源改变，或超过有界扫描预算 |
| source_unavailable | 未支持补收、断连或读取失败 |
| terminal_changed | PTY 或 CLI 已改变 |
| identity_unconfirmed | 没有可靠候选，或请求目标不是观察到的身份 |

原 invalid_request/not_found/conflict/storage_unavailable 等契约保留。日志缺口不能仅靠点击“确认”变成可信来源，手工入口同样会拒绝；本轮不提供忽略证据的强制接管。

## 前端兼容与新增诊断

现有 `frontend/src/api/aiSession.ts` 与 `ai-session/useAiSession.ts` 已在关闭后重连，并用新快照替换；本轮未改前端。

sync 增加可选 `pendingIdentity: { nativeSessionId, reason }`。有正文且 gap 中出现另一候选时，lastError 保持 `needs_rebind` 以兼容已有提示，具体 reason 为 source_gap。其他 reason 包括 binding_conflict、ordered_replay_required、live_identity_unconfirmed、history_unavailable。无候选的 gap 和非法页分别可显示 source_gap/invalid_replay。

前端若完善体验，只需接原因文案和“已切换对话”的提示；历史仍用 P0 generations/messages API。不得把未经验证的候选当作已绑定会话。

## 验证

- 后端全套 134 项通过，默认跳过的真实 omp 用例单独开启后通过；workspace-store 38 项、bridge 7 项通过；backend/store typecheck 与 workspace 边界检查通过。
- 单元：有正文 A→B→A、固定 horizon、重复/迟到、gap、旧 PTY、异步期间 CLI/外部 generation 改变、dispose、通知回调异常、无耐久历史时拒绝。
- HTTP/WS + SQLite：自动切换关闭旧连接、重连新快照、旧代查询、conversation 复用；真实 SQLite trigger 注入换绑写失败，确认旧正文/代/游标/WS 保留，解除故障后成功。
- 手工：页间高水位增减、最终尾部变化、乱序/重复/缺口、无身份、路径归属、64 页预算；同请求重试不重复换绑。
- 真实 omp：隔离 worktree cwd、数据目录、端口和 daemon。已有正文后 `/new`，新 native ID 自动跟随、新回复同步；旧代历史仍可查；网关重启和原日志删除后的耐久详情仍可读。真实用例验证 A→B，A→B→A 由受控日志集成测试覆盖；没有浏览器视觉验收。

真实用例命令：

```sh
ROOST_VERIFY_OMP=1 ROOST_VERIFY_OMP_REBIND=1 ROOST_OMP_WORKTREE=/tmp/diy-omp-readonly-sync node --import tsx --test backend/tests/omp-live.test.ts
```

本轮未实现：更换 PTY 后自动接管、多个终端抢占同一原生对话、omp 活动分支信号、其他 CLI transcript 适配、GUI 输入/权限批准。
