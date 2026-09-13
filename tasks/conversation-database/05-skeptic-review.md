# 独立反方审查：对话数据库与 Agent 通讯

日期：2026-09-09。审查角色：独立反方；审查对象为 `01-product-research.md`、`02-agent-messaging-design.md` 及下列现有实现。本文只记录可验证的风险和放行条件，未运行测试、未修改业务代码、未调用模型、未重启服务。

## 审查结论

继续使用 SQLite、将长期对话与终端执行分离、先保存信件再异步投递，这些方向没有发现需要推翻的理由。问题在于几个跨模块约定仍未固定；如果直接按各自理解并行编码，测试可能各自通过，但系统仍会误投或丢历史。

严重性约定：P0 指可能造成不可逆历史丢失或错误执行，P1 指会破坏核心一致性/可恢复性，P2 指应在接口冻结前澄清的体验与契约问题。以下是设计阻塞点，不代表这些新功能已经上线存在事故。

当前处置状态：R1—R8 均待设计修订或实施证据闭环；本文给出建议不代表问题已经解决。实施与审查分工遵循 [团队与交付门槛](03-team-and-gates.md)。

| 编号 | 等级 | 性质 | 阻塞哪个交付 |
| --- | --- | --- | --- |
| R1 | P0 | 新增升级协议缺口 | 独立历史迁移 |
| R2 | P1 | 已知 scope 限制遗漏一处实现 | 多来源身份支持 |
| R3 | P1 | 新增事务组合缺口 | 收件箱和变更日志 |
| R4 | P0 | 已知所有权风险尚缺可执行协议 | 原生自动投递 |
| R5 | P1 | 新增幂等作用域歧义 | Agent 工具入口 |
| R6 | P1 | 新增备份恢复游标漏洞 | 耐久 changes |
| R7 | P1 | 已知回执限制需要细化存储证据 | 原生 accepted 状态 |
| R8 | P2 | 新增 API/删除语义空白 | 对外契约冻结 |

## R1：新 schema marker 不能阻止仍存活的旧写入者

- **触发条件：** 新 gateway 完成目录迁移，旧 gateway 或 daemon 的连接仍然打开；旧实现调用 `deleteSessionRecord` / `aiSessions.remove`，或旧 bridge 继续写入。
- **依据：** `store.ts` 先删除 commands，再调用 `aiSessions.remove`；后者显式删除最后一个 generation 所关联的正文。已有 `ai_history_writer_insert/update` 只校验 `storageFormat=2` 的记录写入，不拦旧格式兼容的删除。新增 marker 不会自动改变已运行进程的函数。
- **后果：** catalog 留着但正文/回执被旧进程删除；新旧 writer 对 scope 的解释也可能不同。代码回滚不等于数据回滚。
- **建议修正：** 迁移方案必须包含 writer 兼容矩阵和升级门控：先阻止旧 writer 再开放新 schema。可选择受控关闭所有写库连接、确认版本后迁移，或实现数据库级兼容屏障；不能把“daemon 可以继续运行”扩展成“旧版本 daemon 可以继续任意写新库”。明确失败回滚方式与禁止降级写入条件。
- **验证方式：** 使用同一文件库的两个独立进程，保留一份旧版删除/保存行为；新进程迁移后触发旧进程删除和保存，必须明确拒绝且正文、catalog、必要回执不变。再验证正常新 writer 可写。只测试冷启动迁移不覆盖此问题。

## R2：scope 不只在 ai_conversations 中缺失

- **触发条件：** 两个原生来源的 CLI/native ID 相同，scope 不同；新 sources 和底层 conversations 已分开，但仍保存 live binding。
- **依据：** `ai-sessions.ts` 还存在 `ai_session_native_identity` 唯一索引，仅包含 binding.cliId 和 binding.nativeSessionId。`ai-commands.ts` 的接收回执索引和查重也没有 source scope。草案已指出后者，但尚未列出前者。
- **后果：** 数据库目录可以容纳两个来源，第二个 binding 却因唯一冲突无法识别；只测 catalog 的多来源用例会给出假阳性。
- **建议修正：** 将 binding 类型/校验、摘要生成、全部唯一索引、查找与回执查询列成一次身份迁移清单；scope 来源必须固定。第一阶段一个 catalog 对应一个 source 的规则应有 `UNIQUE(conversation_id)` 等数据库约束，而不只是文档约定。来源不明的旧记录禁止靠相同 native ID 自动升级成新 scope。
- **验证方式：** 构造两个 scope 同 CLI/native ID，贯穿自动绑定、正文写入、重启加载、收件箱路由与接收回执；同时反证相同 scope 重复绑定不能创建另一条用户对话。不要只 assert sources 行数。

## R3：现有事务 helper 不能直接组合成跨域事务

- **触发条件：** 新 service 在 `transaction()` 中调用现有 `aiCommands.enqueue/update`，希望顺带写 delivery 与 changes；或者先写 A 连接，再等待 daemon IPC 在 B 连接补齐。
- **依据：** `database.ts` 的 `transaction()` 固定执行 `BEGIN IMMEDIATE`，command 方法内部也调用它；history 则用 savepoint。`openDatabase()` 配置 WAL 和 busy timeout，但没有统一声明外键执行策略。
- **后果：** 前一种出现嵌套 BEGIN 错误；后一种在中间崩溃留下 command/delivery/changes 不一致。仅在新 DDL 写 `REFERENCES` 也不能替代每个连接的外键策略。
- **建议修正：** 固定一层 store unit-of-work 拥有事务，内部方法共享同一连接且不重复 BEGIN；或统一支持可组合 savepoint。业务 mutation 与它的 changes 同连接提交。跨 IPC 步骤明确拆为持久意图与幂等对账，不能用一个名字叫 transaction 的协调器冒充原子提交。显式决定新表外键/删除策略，并核验所有连接配置及旧数据兼容性。
- **验证方式：** 使用真实文件 SQLite 和两个连接/进程测试；在信封、delivery、changes 每一步注入异常，分别验证同事务全回滚和跨进程可对账。测试父事务回滚、锁竞争和启动重放，不能用内存 map 替代存储。

## R4：owner_epoch 必须落实到实际写入者，不能只锁调度器

- **触发条件：** 旧 owner 在校验 epoch 后暂停，新 owner 获得新的 epoch；旧 owner 恢复并写 PTY。或仅因心跳超时把 unknown run 标为 ended，再创建新 active run。
- **后果：** 两个进程都向同一原生上下文写入，或者旧队列写入已切换身份的 TUI；条件唯一索引只能约束数据库行，不能撤回已经离开数据库的写入权。
- **已有设计：** 草案正确要求执行边界检查、接管前确认旧写入者已退出或隔离。因此这是已有风险的落地阻塞，不是发现了相反证据。
- **建议修正：** 第一版明确单一 daemon 输入执行者，gateway 只能提交意图；epoch 的分配、校验和 run/source 对应关系进入协议。接管失败保持 unknown 并停止发送，不能超时后假定获得原生写入权。数据库 claim 与 IPC 之间可以分开，但旧 daemon 实际写入必须被排除。确定 uncertain 阻塞按 recipient/source 生效，不能换新 run 就绕过。
- **验证方式：** 用同步屏障将旧 owner 停在“校验后/写入前”，让接管发生后再恢复旧 owner，记录真实 write spy，旧写入必须为零。另测 source 身份切换、相同 source 新 run 和两个 gateway 并发 enqueue。仅对两个数据库 claim 断言一个成功不够。

## R5：sender_scope 稳定性决定重试会不会变成第二封信

- **触发条件：** A 成功保存信件但响应丢失，随后 A 的 run/token/连接变化，再使用相同 requestId 重试。
- **后果：** 如果 sender_scope 从 runId、临时 token 或连接派生，唯一键变化，原请求被当成新请求；如果所有用户共用 scope 而 requestId 只在页面局部唯一，又可能误报冲突。
- **建议修正：** 分开“长期幂等命名空间”和“本次调用权限”。Agent 的幂等域建议由稳定 conversationId 与调用者类别构成，当前 run 只用于核验授权和留痕；GUI 用户采用稳定的本应用用户/安装身份。契约要求 requestId 是一次逻辑请求的持久随机 ID，回复失联后复用。规范化哈希包含收件人、正文和回复关系，明确 null/省略等价性。旧 run 撤权后不得靠重试重新获得发信权。
- **验证方式：** 入库后断开响应，恢复 A 为新 run，使用相同 key/body 返回同一 messageId；更换 body/目标返回 409。不同发送方相同 key 相互独立。对已撤权 run 的请求验证拒绝且不新增记录。

## R6：lineage 随旧备份一起恢复，不能单靠一个持久 UUID 检测倒退

- **触发条件：** 浏览器保存 cursor=(L, 900)，恢复旧备份，其中仍然是 lineage L，但当前 seq=700；随后新事件重新增加至 900。
- **后果：** 如果只比较 lineage，相同序号被当作已看过，GUI 跳过恢复后新变化。客户端 cursor 大于当前 max 的检查只在序号尚未追平时有效。
- **建议修正：** 定义恢复操作必须旋转独立的 restore epoch/incarnation，并使 cursor 包含它；不要把 lineage UUID 的持久化本身当作恢复检测。受支持恢复入口统一执行此操作。若不能可靠检测用户手工替换库文件，明确不支持热替换并在每次服务器启动生成新的订阅 epoch、要求旧客户端重新快照，代价是多一次快照而不是静默丢事件。
- **验证方式：** 保存 cursor 后备份回退，并先产生足够新变化超过旧 seq，再让旧客户端连接，仍必须收到 resync_required。只测试 cursor > max 的情形不够。

## R7：接受证据、消息关联和重启恢复需要保存不同的信息

- **触发条件：** CLI 已接受，daemon 在 hook/原生 UUID 落库前退出；或者 transcript 晚到/被截断；或用户手工输入与自动消息正文恰好相同。
- **依据：** 当前 `ai-command-owner.ts` 使用 hook 序号、inputEpoch、精确正文、transcript 偏移/文件身份共同验证。`proofs` 中的 path、identity、decoder/partial 只存在内存，重启时被清空。当前保留 uncertain 是合理保守行为。
- **后果：** 仅保存 nativeMessageId 不足以追溯 accepted；只按正文扫描恢复容易把手工输入误认为自动投递。如果实现者把缺失 receipt 理解为未发送，就会重发。
- **建议修正：** 定义 receipt 的版本化 evidence kind、source/run、原生 ID、观测边界及可恢复能力。适配器若不能在重启后可靠对账就保持 uncertain，第一版无需承诺自动消除它。GUI 关联以受证实的原生 ID 为准；临时未采集正文可保持“已接收，历史待同步”，不要制造 transcript。对一个 source/native message 只能关联一条 delivery 设唯一约束。
- **验证方式：** 在原生写入前、写入后、hook 后、receipt 入库前分别杀进程；重放相同正文的人类输入和历史老消息不能清除 uncertain。测试采集延迟下不重复展示，重启后不自动重发；真实 CLI 验证不可由伪造 accepted 回调替代。

## R8：disabled、垃圾箱、取消与回复关系尚不能由前后端自行解释

- **触发条件：** 向 inbox_policy=disabled、archived、trashed 或不存在目标发信；重复请求在目标被移入垃圾箱后重放；取消与 dispatch 同时发生；B 回信关联一条并非发给 B 的信。
- **后果：** 不同入口返回不同语义；前端显示“已取消”而消息已写入；无关消息被串成同一对话链。草案同时说 disabled 和 unsupported 可 queued，需要进一步区分接收策略与当前投递能力。
- **建议修正：** 冻结状态/错误码矩阵：策略禁止接收与运行时暂不支持分别处理；明确幂等重放的返回优先级；cancel 仅通过 queued 的条件更新成功；trash 与 queued/dispatching/accepted 各状态制定行为。在永久删除前保存对外引用的 tombstone 或明确脱敏策略，不级联删掉其他参与者的信件证据。inReplyTo 校验发送者是原信合法参与方，并决定单目标回信限制。
- **验证方式：** API 契约表驱动测试覆盖所有状态组合，以及两个连接并发 cancel/claim、trash/enqueue。分别断言 HTTP code、稳定 error code、数据库状态和是否发生原生写入。

## 已知限制，不应反复包装成新缺陷

- SQLite 与第三方 CLI 不存在一个共同原子事务；uncertain 不自动重试是正确选择。
- 无可靠输入或生命周期证据的 CLI 保持只读/排队，是能力边界；数据库完成不代表所有 CLI 双向同步完成。
- 保存 GUI transcript 不保证 CLI 隐藏状态、外部工具环境或原生文件可恢复。
- 本阶段使用测试适配器验证路由是必要步骤，但不能替代同版本真实 CLI 的 TUI/GUI 闭环。
- 不需要为了三个本地 Agent 先上外部消息中间件或分布式数据库。

## 独立审查放行方式

实现者提供变更与自测；测试 Agent 独立构造失败场景；反方 Agent 按 R1—R8 逐项检查证据，记录“已验证/未覆盖/接受限制”，不以口头回复替代验证。P0 和对应阶段的 P1 未闭合时，该阶段不宣称完成。

最小证据分层：真实 SQLite 文件/跨进程结果、崩溃恢复结果、原生适配器合同结果、真实 CLI TUI/GUI 观测。每层记录版本与范围；前三层全部通过，也不能写“真实 TUI/GUI 同步已通过”。

旧测试有意验证的生命周期需要随新契约调整：`ai-history-store.test.ts` 第 49、143 行要求最后一次 remove 后 body 清空，`ai-commands.test.ts` 第 26 行要求删除终端后 commands 为空。不能为保留“全绿”继续保留旧删除行为，也不能简单删掉这些断言；应替换为终端临时数据清理、独立历史保留、必要 receipt 可追溯与显式永久删除的分别验证。

本次审查依据的源码：`packages/workspace-store/src/database.ts`、`store.ts`、`ai-sessions.ts`、`ai-history.ts`、`ai-commands.ts`、`packages/terminal-daemon/src/ai-command-owner.ts`。未检查私人对话正文。
