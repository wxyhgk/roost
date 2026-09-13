# 独立测试计划：对话数据库与 Agent 通讯

日期：2026-09-09。状态：测试设计与源码审查完成；本轮没有运行测试、迁移数据库、启动真实 CLI 或请求模型。文中的用例、命令和验收均是后续执行计划，不能记为通过。

范围依据：[产品与数据库方案](01-product-research.md)、[Agent 通讯设计](02-agent-messaging-design.md)。测试负责人独立于实现者；前端由前端人员实现，后端测试不代替浏览器验收。

## 1. 独立测试负责什么

- 实现者交付代码、变更范围和自测结果；测试人员根据契约设计反例，独立运行并留证，不能把开发者的“已通过”直接复制为验收结论。
- 每阶段先固定外部行为、状态转移和故障结果，再写测试。实现若改变契约，测试负责人和反方审查者先复核，不能为了绿色结果删断言或扩大重试。
- 反方审查者负责质疑假设并给出最小反例；测试人员将成立的反例变为可复现用例。协调者解决契约争议和整合，不能以多数 Agent 认为正确代替证据。
- 测试报告分别列出：静态检查、自动化单测、进程集成、真实 CLI、浏览器观察。每项标注通过/失败/跳过/未运行及原因，不使用一个总“完成”隐藏未覆盖层。

## 2. 验收不变量

1. conversationId 属于长期对话：改名、移动项目、重连及恢复同一原生对话不换 ID；分叉和切换另一原生对话不串历史。
2. 删除最后一个终端不会删除 catalog、已保存正文、信封以及投递所需 command/回执；退出和归档不冒充永久删除。
3. 重试相同逻辑请求只保存一份信封及每目标一份 delivery；相同正文的两次独立请求必须保留为两条。
4. 一次原生写入只能交给经验证的目标 source/run/owner epoch；不能因为 terminalId 相同就把 B 的来信发给切换后的 C。
5. 已排队、已开始写入、原生确认接收和产生回复是不同事实。未知写入结果不得自动重发，不承诺第三方模型恰好执行一次。
6. accepted 必须有符合适配器契约的原生证据；同一原生消息不能确认两次投递，不同 source 的相同 nativeMessageId 不冲突。
7. GUI 显示的原生输入/输出与 TUI 属于同一原生会话；pending 来信是独立状态，不能提前伪造 transcript。
8. 已提交的数据变化能经 cursor 补收；事务回滚的变化不能被推送，断线与备份恢复不能静默跳过消息。

## 3. 分阶段测试与准入门槛

| 阶段 | 测试人员交付 | 通过后允许 | 阻塞条件 |
| --- | --- | --- | --- |
| D0 契约冻结 | ID/状态转移/删除/幂等/游标/错误码矩阵，记录未决项 | 开始对应模块实现 | 状态有两种解释，或仅凭超时决定“可重发” |
| D1 独立历史库 | 旧库迁移、删除边界、scope 唯一性、独立 API、分页和 revision 回归 | GUI 接入独立历史读取 | 任一正文丢失/串库，迁移重试重复目录，离线查看触发 CLI |
| D2 通讯与 run | 假适配器的 A/B/C 路由、并发、幂等、所有权、崩溃矩阵与 changes 补收 | 进入一个真实 CLI 的隔离验证 | 误投、重复原生写入、owner 无法被隔离、uncertain 自动重发 |
| D3 单 CLI 闭环 | 指定版本的 Agent 发信入口、原生接收证据、TUI/GUI 可见结果、回信和故障证据 | 只开放该已验收适配器能力 | 假服务代替真实 CLI；仅 API 有消息而 TUI 不刷新；发送产生第二个执行进程 |
| D4 逐 CLI 扩展 | 每版本能力矩阵及独立证据，回归 D1/D2 公共契约 | 分适配器开放能力 | 用一个 CLI 的结果外推其他 CLI，或版本不支持却显示可发送 |

D1 可独立交付；D2 未通过前不开放 Agent 自动投递。D3 的真实模型请求和浏览器验收安排在独立执行批次，本轮不执行。

## 4. D1 数据库、迁移与删除矩阵

| 用例 | 夹具/动作 | 必须观测的结果 |
| --- | --- | --- |
| H01 旧库升级 | 用旧 schema 固定夹具，含多个 CLI、A→B→A generations、正文修订、source_backed、丢失窗口 | 旧主键/正文哈希/顺序/修订保留；不完整标记不被清零；一原生来源只建一目录 |
| H02 重复及中断迁移 | 子进程在 marker 前、中间写入后、提交后分别退出，再重复打开 | 提交前整体回滚，提交后不重复；不会出现目录已迁而旧删除逻辑仍启用的混合模式 |
| H03 一致性备份 | 临时文件库开启 WAL，另连接持有写入；使用支持的一致性备份入口恢复到新目录 | 恢复库 integrity_check/foreign_key_check 正常，事务全有或全无；不以只复制主 db 作为备份 |
| H04 最后终端删除 | 已存完整正文、source_backed 预览、投递及回执；删除唯一终端并重开 store | 独立 catalog/messages/inbox 仍可读；已存正文哈希不变；缺失源内容明确不可读，不能伪称完整 |
| H05 组织操作 | 项目删除、归档/取消归档、进回收站/恢复 | 正文与来源不变；项目删除解除分组；回收站拒收新信，在途处理按固定契约执行 |
| H06 永久删除边界 | 删除对话时仍有另一对话的来信/回信引用 | 删除规则必须先确定：保留必要信封还是 tombstone；不级联删除他人正文，不留下不可解释外键 |
| H07 来源碰撞 | 两个 origin 使用同 cli/native ID/nativeMessageId；同 origin 重连新 terminal | 两来源可同时持久化与绑定且互不串读；同来源重连复用 ID；legacy 未知不随意合并 |
| H08 离线与丢失源 | daemon 不启动，原生文件删除/截断/格式未知 | 已存消息可分页读取；覆盖信息准确；只读 API 对 spawn/PTY 写入计数为零 |
| H09 分页与元数据竞态 | 固定上界读取途中新增消息、修订旧消息；两个连接提交相同 revision | 无静默漏读；旧 cursor 按契约续读或明确失效；一个 PATCH 成功另一个 409，不覆盖标题 |
| H10 规模与按需读取 | 10 万条合成消息，正文含大字段；查询单页列表及搜索 | 列表有明确数量/字节上限，不读取全量正文；记录耗时/内存基线，避免机器相关的盲目时间阈值 |
| H11 滚动升级旧 writer | 旧 gateway/daemon 保持连接，新进程迁移临时库后让旧 writer 保存、删除、recover | 不允许旧删除/恢复逻辑破坏新目录和回执；明确拒绝旧写入或协调停止旧 writer，不能只检查新 schema marker；旧只读接口兼容范围单独验收 |

H06 的“永久删除与跨对话信封关系”目前尚需冻结，不能由 FK CASCADE 偶然决定。若首期不提供永久删除 API，应明确不支持，并测试没有间接清理入口。

## 5. D2 投递与重启故障矩阵

所有故障使用可控屏障定位到写入边界，不靠随机 sleep 碰运气。W 为测试适配器的实际 native write 次数，accept 为独立原生证据记录。

| 用例/故障位置 | 注入动作 | 预期状态与证据 |
| --- | --- | --- |
| M01 双调用并发重试 | 两连接同时提交同 senderScope/requestId/payload | 一信封一 delivery，W≤1；返回同 messageId |
| M02 键复用冲突 | 同键更换目标、正文或 inReplyTo；另发不同键同正文 | 前者 409 且无多余 changes，后者是新信件；规范化规则先冻结 |
| M03 提交边界 | commit 前崩溃；commit 后 HTTP 响应前崩溃 | 前者无半条信封；后者重试拿到原记录，发送方/收件方变化均可补收 |
| M04 A/C 同发 B | 固定屏障并发入队，B 仅允许一个 in-flight | enqueueSeq 无冲突；按数据库顺序发送，无交错输入；不是以请求抵达网络的时间假设先后 |
| M05 草稿/忙/权限弹窗 | 原生呈 busy 或存在未提交草稿，再变 idle | 等待期间 W=0，不清草稿、不批准弹窗；就绪后只投当前队首 |
| M06 绑定变化 | 已选中 B run，最终写入前 terminal 切成 C 或 instance/generation 改变 | W=0 或保守 uncertain；绝不向 C 发送 B 信件；原信不因同 terminal 自动改目标 |
| M07 两 owner 竞争 | 两独立连接竞争 source active run；旧 owner 停在写入前屏障后尝试接管 | 只有经验证 owner 可写；旧 epoch 不可写；不能证实旧 writer 已停时拒绝接管发送 |
| M08 原生写前崩溃 | durable dispatching/command writing 已保存，但测试确知尚未 native write 时 kill 子进程 | 恢复按持久证据判定；没有确证也应 uncertain，不能凭测试知道 W=0 就让生产自动重发 |
| M09 原生收后回执前崩溃 | adapter 记录原生输入并独立 flush，回执落库前 kill | 对账得到同 source/nativeMessageId 后 accepted，否则 uncertain；重启/超时 W 不增加 |
| M10 IPC 响应丢失 | daemon 接收稳定 command requestId 后断开 gateway | 查询同一 command，不能生成第二请求；history/receipt/changelog 投影可幂等补齐 |
| M11 重启恢复 | queued、dispatching、accepted、uncertain 混合，替换 daemon 或仅 gateway | 两类重启结果分别断言；恢复映射不全量置 queued，不影响不属于该 owner 的运行 |
| M12 uncertain 阻塞 | B 第一条 uncertain，后面还有 A/C 来信 | 后续 W 不增加；用户处理动作与迟到回执竞争有确定结果，旧信不能被迟到事件重新发送 |
| M13 原生回执乱序/重复 | 两独立同正文请求，旧 transcript 重读、重复 hook、迟到 accepted | 一回执最多确认一个 delivery；正文相同不能单独充当接收证明；错误 source/epoch 证据无效 |
| M14 取消与出队竞态 | cancel 与 claim/final write 屏障交错 | 只有 queued 可取消；已开始写入拒绝取消或报告不可撤销，不能界面 cancelled 但暗中继续投递 |
| M15 删除与在途竞态 | 删除 terminal 或把 B 移回收站时，投递处于各阶段 | 历史与必要证据保留；新投递拒绝；在途不能静默消失或重发，结果符合明确状态表 |
| M16 回复与循环 | B 正常 assistant 输出；B 显式 reply A；A 再明确发 C | 普通输出不会自动产生 peer 信封；显式回信正确关联；超出深度/预算/队列上限明确拒绝或暂停 |
| M17 跨 run 发送者幂等 | A 原 run 已提交但响应丢失，恢复 A 新 run 后重试同 requestId；伪造请求体 sender=A | 合法恢复重试返回原信封，不因 run 改变重复投递；senderScope 来自可信上下文，伪造不改变归属；不同真实 conversation 使用同 requestId 不互相吞信 |

第一版单收件人即可。未来 fan-out 才加入“一信封两 delivery、B 成功 C 失败互不覆盖”的用例，不提前假报多目标能力。

## 6. GUI changes 与原生历史关联

- C01：业务写与 changes 同事务；故障触发回滚时两者都无新增，推送只发送已提交 seq。
- C02：读取快照与上界 cursor 的事务中同时制造新提交；从快照过渡到补收/订阅没有遗漏窗口。测试推送重复、断线、重连，客户端按 seq/revision 消重。
- C03：过滤 B 的 changes 时包含其他 conversation 导致的序号空洞；游标代表扫描位置，不能把空洞判成消息丢失或无限重扫。
- C04：日志保留窗口外返回 resync_required；恢复旧备份或更换库后 lineage 不匹配必须重建快照。启动恢复流程需明确何时轮换 lineage，不能只在表中存一个会被备份一起还原的 UUID。
- C05：accepted 与 transcript 入库先后互换、重复投影、消息修订和正文补全；GUI 模型中仅一条原生输入，pending 卡片通过关联合并；历史 revision、GUI cursor、PTY seq 互不混用。
- C06：后端无 WebSocket 观察者时仍保存变化；新 GUI 进入已删除终端的对话能读取历史和未投递信件。
- 后端测试使用 reference reducer 验证可消费性；真正浏览器中卡片不重复、状态更新、TUI 显示及滚动仍交给前端测试。仅 HTTP/WS 通过不足以声称页面同步完成。

## 7. 夹具与隔离

- 单元测试用合成内容与临时 SQLite；涉及两个连接、WAL、重启的用例必须用独立临时文件库，不能只用 :memory: 或同一 JS 调用栈冒充并发。
- 每个用例独立 dataDir/socketPath/随机 HTTP 端口；禁止使用日常 `~/.diy-ai-coding-web`。不改全局 CLI 配置、不读取私人正文、不启动每日 daemon。子进程仅终止该用例登记的 PID，finally 关闭 server/连接/store 并清理目录。
- 迁移夹具由明确版本的旧 schema 和合成数据构造，不用当前 createWorkspaceStore 先生成“旧库”掩盖迁移缺陷。保留 fixture 版本及迁移前后摘要。
- 测试适配器提供 beforeClaim/afterClaim/beforeWrite/afterNativeAccept/beforeReceiptCommit 等屏障、可注入时钟和持久 native ledger。native ledger 与平台 SQLite 分开，避免同一错误实现同时充当断言依据。
- 崩溃用子进程 IPC 到达屏障后退出/终止，重开同一个临时库核验；至少覆盖一次非优雅退出，不能只调用 dispose 模拟断电。
- 集成报告记录 seed、故障点、事件序列、DB 状态摘要和实际 W。随机探索作为补充，失败后固化为确定性最小用例。

## 8. 真实 CLI 验收证据

每种 CLI 按实际 `--version` 单独登记 read/bind/send/receipt/TUI-refresh/Agent-tool 能力。真实 CLI 测试显式 opt-in；有模型调用的场景另列费用行为和执行结果，本次未执行。

闭环固定为：新建隔离 A/B/C → 确认三套 native 身份 → A 通过实际 Agent 工具入口发带唯一标记的消息给 B → B 原生收到 → B 明确回信 A → C 的历史和输入计数保持不变。随后验证 B 忙/草稿、gateway 重连、daemon 退出与恢复。

每次报告至少包含：

1. commit/dirty patch 范围、CLI 版本、适配器版本、临时工作目录与运行时间。
2. conversation/source/nativeSession/run/terminalInstance/ownerEpoch 的对应表（无鉴权数据）。
3. messageId/deliveryId/commandRequestId/nativeMessageId 及关键状态时间线；确认来自独立原生读接口或 transcript。
4. TUI 屏幕或录屏可见唯一测试标记及实际回复；GUI 浏览器显示同一标记、同一身份，pending→accepted 关联后无重复。
5. PTY/原生执行进程清单，证明没有为 GUI 偷开第二个写入者；非目标 C 未收到输入。
6. 恢复后 W 与原生记录数量没有因重试增加；不能确认时保留 uncertain，报告未完成而非跳过失败。

无法提供第 4 项时，可声明“原生接收和后端同步通过”，不能声明“TUI/GUI 页面闭环通过”。没有 Agent 可调用入口时，手工 curl 只能验证 API，不能声明“Agent 间通讯可用”。

## 9. 源码已证实的现状与必须纠正处

以下是本轮实际读取源码得到的事实，不是已执行的测试结果；上文 H/M/C 编号均为尚待实现和运行的验收用例。

- `packages/workspace-store/tests/ai-history-store.test.ts` 已有迁移、修订、分页和 10 万消息夹具，但 A→B→A 用例仍断言 remove 后正文为 0；新所有权模型必须有明确的新删除断言。
- `packages/workspace-store/tests/ai-commands.test.ts` 已有跨连接幂等、crash recovery、回执唯一性，但删除终端后 commands 清空也是当前测试要求。要区分无引用临时命令和需保留的 delivery 证据。
- `packages/workspace-store/src/ai-sessions.ts` 的 `ai_session_native_identity`、`ai-history.ts` 的原生唯一约束/hash、`ai-commands.ts` 的 receipt 索引都未包含完整 source scope；不能只迁移其中一张表。
- `aiCommands.recoverOwner()` 当前遍历全部 active 命令；未来有 run/owner 后必须验证恢复作用域，不能一个新 owner 取消其他 owner 的命令。
- `backend/tests/claude-send-live.test.ts` 存在 opt-in 真模型场景，可复用隔离与原生回执观察；源码存在不代表本轮运行过，也不能证明新的 peer 通讯已支持。
- `backend/tests/opencode-live.test.ts` 当前验证 TUI 身份切换与 gateway 恢复，且不发模型 prompt；它不覆盖真实发送与 TUI 回复刷新。

## 10. 执行命令与结果登记

后续按改动范围执行（本轮未执行）：

```sh
npm run typecheck --workspace @roost/workspace-store
npm test --workspace @roost/workspace-store
npm run typecheck --workspace @roost/terminal-daemon
npm test --workspace @roost/terminal-daemon
npm run typecheck --workspace backend
npm test --workspace backend
node scripts/check-boundaries.mjs
```

涉及 terminal-protocol / ai-session-bridge / ai-transcript 的改动再加入相应包检查；完整集成时跑仓库规定检查并单独记录前端结果，不能因本任务后端专属就宣称 frontend build 已验证。

每次结果文件写入本文件夹的 `verification/`，包含用例 ID、命令、退出码、passed/failed/skipped 数量、版本与补充人工证据。失败必须指向责任模块与复现步骤；未决契约、未运行的真实 CLI、被跳过的浏览器检查保留为显式交付限制。

目前最重要的阻塞项：永久删除与跨对话信封引用规则、备份恢复的 lineage 轮换机制、owner 接管前对旧 writer 的隔离证据、uncertain 的人工处理与迟到回执竞态。这四项应在相关模块编码前冻结，测试不能替设计作隐式决定。
