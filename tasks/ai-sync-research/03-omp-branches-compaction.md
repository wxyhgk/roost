# omp 分支、恢复与压缩：只读同步的边界及实施方案

调研日期：2026-09-09。范围：后端研究，不改业务代码、不运行真实 CLI、不读取私人聊天。本报告的 API/schema 是建议，尚未实现。

## 结论

应先让后端正确保存 **所有记录的树结构、压缩边界、来源可靠度**，再提供历史分支查询。不能将“JSONL 最后一行”直接宣传成“TUI 当前分支”。只读文件能还原磁盘历史树和选定 leaf 的路径，但 CLI 可仅在内存里切换 leaf，也可向非活动分支写消息。准确跟随 TUI 必须新增 agent 侧显式活动 leaf 通知或查询接口。

从使用者看，这样拆的好处是：先保证旧对话不会错误混入新分支；用户仍可阅读所有历史；获得明确的 agent 信号后，才打开“自动跟随终端当前分支”。压缩记录也应该表示“上下文已压缩”，而不是把旧对话永久删除。

## 证据与版本

- 当前适配器：`packages/ai-transcript/src/index.ts:55-96`、`:99-154`，当前工作区源码。
- 本地 fork：`/Users/you/Code/oh-my-pi-hanhua`，commit `d30adf0698ad92a643110891f88641d4703ae3bf`，`packages/coding-agent/package.json:4` 为 **17.2.14**。另一候选 `/Users/you/Code/tmp/opencode_test/oh-my-pi` 为17.2.8，HEAD不能解析，故不作为版本基线。
- 本机 `/Users/you/.local/bin/omp` 是编译二进制，未找到可直接核对的安装源码包。现有 `tasks/omp-transcript-implementation.md:9` 记录之前真实验证版本为18.1.11；本轮没有重跑版本或会话探针。
- 为避免只凭旧 fork推断，下载并核对官方 **v18.1.11** tag，GitHub ref解析为 commit `e3106be68f778635da3a17106835ce2e0e6992af`。下面上游行号全部对应该提交，不对应浮动 main。它证明同版本上游语义，不能证明本机定制二进制没有额外修改。
- [官方 session-manager.ts](https://github.com/can1357/oh-my-pi/blob/e3106be68f778635da3a17106835ce2e0e6992af/packages/coding-agent/src/session/session-manager.ts)、[session-context.ts](https://github.com/can1357/oh-my-pi/blob/e3106be68f778635da3a17106835ce2e0e6992af/packages/coding-agent/src/session/session-context.ts)、[session-entries.ts](https://github.com/can1357/oh-my-pi/blob/e3106be68f778635da3a17106835ce2e0e6992af/packages/coding-agent/src/session/session-entries.ts)。本轮只读副本位于 `/tmp/omp-v18.1.11-session-{manager,context,entries}.ts`。

## 已确认语义

### 1. parentId 串的是所有 entry，不仅 message

本地 `session-manager.ts:189-282` 的索引维护 `id → entry`、`parent → children`，按 parent 从 leaf 回溯再 reverse，得到 root→leaf路径。新条目的 parent 来自内存 leaf（`:1071-1085`）。消息之间可能隔着 model_change、label、custom、compaction 等节点。

当前适配器只保留 message 的 parentId，忽略其他已知 metadata；因此即便前端拿到 parentId，也不足以自行重建树。需要单独存结构节点，不能只在现有消息上加几个属性。

### 2. 文件末尾不足以证明正在显示哪个分支

官方v18.1.11 `session-manager.ts:2658-2665` 的 branch/resetLeaf仅改内存。`:2299-2319` 的 appendMessageToBranch写入非活动分支后恢复原先 leaf。`:2670-2676` 明确指出内存leaf变动会在reload时丢失，需要额外写入结构标记才能持久化。

所以相同的文件字节可对应两个不同的实时TUI状态。继续增加fs.watch、提高轮询频率，都不能恢复根本没写入文件的状态。默认可展示“记录历史”，或最后磁盘entry推断的路径，但必须标记 `selectionEvidence: inferred`；只有带顺序保证的agent信号才能标为 `confirmed`。

### 3. resume、fork与同文件branch不是一种身份变化

本地 `session-manager.ts:1259-1316` 恢复指定文件时读取header及entries，沿用header sessionId。`:1332-1354` 的fork创建新sessionId、新文件，parentSession存旧 **sessionId**，复制原entries。`:2333-2388` 的createBranchedSession仅复制选中路径，但parentSession存旧 **文件路径**。

官方v18.1.11同样存在两种parentSession形状（`:1526` 与`:2747`）。不可仅凭parentSession字符串非空就自动建立可信session关联，更不可把文件路径直接作为用户可见会话ID。先保留 `{kind: native_id|path|unknown, value}` 的内部引用，身份模块校验目标header后再建立关系。

同nativeId内换分支不应增加绑定generation；fork/新session才进入身份模块的换绑流程。同一个native message ID在fork复制后可能重复，所以存储主键必须包含资料库会话身份/CLI/nativeSessionId。

### 4. compaction主要改变投喂上下文，不等于删除历史

官方 `session-entries.ts:118-155` 保存summary、shortSummary、firstKeptEntryId、tokensBefore以及可选preserveData；branch_summary另有fromId/summary。`session-context.ts:121-129` 明确区分完整展示与压缩展示；`:376-403` 在历史路径中内联压缩节点，`:299-305` 与后续分支处理决定模型上下文保留部分。

`reset_boundary`（entries`:162`，context`:299`及`:405`以后）也会改变当前有效内容；它不能被当成普通未知行静默略过。第一期保留旧消息并显示压缩/clear节点即可；不要重建或返回provider的私有replacement payload。完整历史展示与“模型此刻所见上下文”不是同一API能力。

### 5. JSONL通常追加，但存在整体改写

本地 `session-manager.ts:396-410` 说明已完成消息才持久化，流式中间文本不保证落盘；官方v18.1.11 `discardEntryDurably:2678-2697` 会重写parent、删除部分entry并改写整个文件。恢复迁移、header修改等也可能改写。

现有reader以inode、长度、mtime、checkpoint末尾64bytes检测变化；这适合作为增量优化，不构成任意原地改写的完整检测。需要将源文件revision与conversation identity分开：检测重写时新建sourceRevision、重新索引并原子发布，不新建用户会话，也不能让旧异步批次污染新revision。

## 当前实现具体缺口

1. `normalize:55-58` 对model/thinking/custom直接忽略，对compaction/branch_summary/reset_boundary标partial；缺少结构节点和压缩视图。
2. `normalize:60-61` 仅user/assistant/toolResult/system；omp扩展role与custom_message可能属于用户可见记录，应明确unsupported类型计数，后续逐项适配。
3. `readOmpTranscript:123-140` 返回物理行顺序的message，形成跨分支拼接；有parentId但无图投影。
4. `TranscriptCheckpoint:6-9` 只有字节进度，没有sourceRevision、结构索引版本、选中leaf来源。`caught_up`只表示读到磁盘末尾，不能理解为内容完整或TUI完全同步。
5. 相同nativeMessageId重复改写，需要按源revision处理冲突；不能永远以eventId去重后忽略新内容。
6. 只保留4096条/8MiB事件缓存不足以回溯历史parent链。结构索引必须在资料库内持久化，不能依赖WebSocket重放窗口。

## 最小实施阶段

### A. 先修记录语义，不引入准确跟随承诺

扩展ai-transcript输出结构化entries，所有合法id/parentId节点都入索引；正文按现有上限规范化。对已知非展示metadata保存kind；未知节点保存有限结构和unsupported状态，不能丢掉桥接parent。增加compaction、branch_summary、reset_boundary展示节点。默认 `view=history`，保留当前记录阅读体验并明确记录语义。

建议的内部表可由统一历史存储模块承接，避免本子任务自行创建第二份资料库：

```text
transcript_sources(source_id, conversation_id, source_revision, fingerprint, offset, checkpoint)
transcript_entries(source_id, source_revision, entry_id, parent_id, ordinal, kind,
                   normalized_summary, detail_ref, coverage)
UNIQUE(source_id, source_revision, entry_id)
INDEX(source_id, source_revision, parent_id)
```

checkpoint、entry及projectionRevision同一事务提交。重复ID且不同内容标记`duplicate_id`，不默默覆盖；缺parent、cycle标`structural_gap`，有界遍历。结构索引保留全部节点，正文可以独立分页/淘汰。

### B. 增加只读历史分支查询

与主报告统一路由命名后再落地，建议概念契约：

```text
GET /api/ai-conversations/:id/branches
GET /api/ai-conversations/:id/entries?leafId=...&view=path&cursor=...&limit=...
```

响应携带sourceRevision、projectionRevision、selectionEvidence、coverage、稳定分页cursor。leaf可由用户明确选择；若仅按末行推断，标`inferred`，不要叫`activeLeafId`。分支选择只影响网页阅读，不调用PTY、不改变CLI。响应示例元数据：

```json
{"view":"path","selectedLeafId":"e9","selectionEvidence":"user",
 "sourceRevision":3,"projectionRevision":12,
 "coverage":{"structure":"complete","content":"partial","liveSelection":"unknown"}}
```

generation表示绑定代次，sourceRevision表示文件改写，projectionRevision表示某次可分页视图：三者不能混用。源变动导致cursor失效时返回明确重载标志，防止两条分支混页。

### C. agent明确支持后，准确跟随TUI

建议新增能力协商 `supportsActiveBranch`，agent发送 `{nativeSessionId, leafId, revision}` 并在branch/reset/resume/append后维护单调revision；文件落盘存在延迟时先等待leaf节点，不能找不到就猜。网关重连需要初始状态查询或可重放事件；只发一次OSC仍会丢。此阶段需要omp端修改或已有可靠SDK通道的验证，不属于仅靠后端读文件可完成的承诺。

## 必须具备的验收fixture

- `u1 → metadata → a1 → toolResult`：parent链完整，展示只过滤节点而不破坏树。
- `u1 → a1 → u2`之后从u1追加a2：history保留两支，指定leaf=a2只返回u1/a2。
- leaf仅内存切到u1但JSONL未变：后端仍标unknown/inferred，绝不能声称已检测到切换。
- 非活动分支追加消息：末行变化不升级为confirmed。
- 分支summary为空的结构标记：仍能影响路径，不能因没有正文丢节点。
- 两次compaction、firstKeptEntryId、reset_boundary交错：历史保留原文；折叠视图另测，不混为模型上下文。
- fork复制相同entry ID到新nativeId：两会话各自可查，不相互去重；path型parentSession与ID型分别验证。
- whole-file rewrite重parent/删节点：sourceRevision更换，旧详情失效，旧异步batch不提交。
- 缺parent、自环、多节点环、重复ID、未知结构节点：有界处理，coverage降级而非崩溃或假完整。
- 重启后跨增量batch重建树、分页并发追加/换分支：不丢链、不重复页、不混投影。

这些是待实现的合成fixture验收要求。本轮仅做源码研究，没有运行测试或本机TUI分支操作；实施后还需隔离会话验证本机定制18.1.11二进制行为。
