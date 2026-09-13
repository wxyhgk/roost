# AI 对话历史分页、耐久存储与详情读取调研

日期：2026-09-09。范围：后端只读源码调研；未运行真实 CLI、未重启服务、未修改业务代码。以下设计均为建议，不能当作已交付功能。

## 结论

下一轮应把“已读到的消息”逐条存进 SQLite，再提供历史分页。单独给当前事件数组加分页只能分页最后一段缓存，不能解决长会话、原文件消失或终端换绑后历史丢失。

对使用者的具体价值：过去读到的对话不会因 CLI 清理日志而消失；向上翻历史不必每次下载数 MB；重开网页、换会话后仍能找回旧记录。必须把“已归档的受支持内容”与“完整原始 CLI 日志”区分，当前超长记录、未知结构和二进制内容并不完整支持。

推荐最小增量：conversation 身份 + generation 绑定关系/观测边界 + 消息表 + 按需正文表 + 导入 checkpoint；保留有限的 WebSocket replay 缓冲，不把它当历史库。暂不引入云同步、搜索引擎、独立数据库服务或通用事件溯源框架。

## 核查基线和证据

主项目 HEAD `dde67009d412b60c18f3d8c58d57fbdf645939a1`，但相关 transcript/bridge 文件存在未提交修改，本文依据 2026-09-09 当前工作区，不能仅用 HEAD 重现。

- `packages/ai-session-bridge/src/index.ts:24-37`：默认 4096 条 / 8 MiB；启动时 `storage.list()` 返回所有记录并复制到内存。
- 同文件 `:44-48` 与 `packages/workspace-store/src/ai-sessions.ts:4-18`：每次提交复制记录、增加 revision、序列化整个 `record_json`；数据库保存 CAS 有效，但不是逐条 append。`list()` 全表读取 JSON 正文。
- bridge `:153-169`：导入先查当前数组是否包含 eventId，追加，再按大小淘汰；checkpoint 与该 snapshot 一起提交，已有原子性值得保留。
- bridge `:143-151,177-190`：文件失败后 `active=false`，读接口过滤掉 transcript 消息，展示 OSC；所以“SQLite 曾存过”不等于“历史仍可见”。
- `packages/ai-transcript/src/index.ts:18,41-51,99-155`：每次数据读取 256 KiB，额外固定 header 64 KiB + tail 64 bytes；行上限 1 MiB；partial bytes、offset、fingerprint 都有 checkpoint。源码没有每次全量读日志的问题。
- 同文件 `:64-95,158-170`：预览有截断，详情按文件位置重新读，校验 fingerprint/hash/recordId；工具详情仍依赖 CLI 原文件。
- `backend/src/server.ts:130-151`：详情 ref 从当前 bridge 可见事件中找，事件被淘汰即无法找到；不能对数万条旧消息提供详情。
- `backend/src/ai-transcript-source.ts:23-52`：每会话单次 busy 保护、每秒一页、失败延迟重试；但同时活跃 N 个会话时总 IO 预算仍随 N 增长。

因此主要瓶颈是全 snapshot 写放大和全量启动加载，不是已有 JSONL 读取方式。上限并非每次恰好达到 8 MiB，故这里是结构分析，未实测线上写放大或延迟。

## 第三方可借鉴部分

### Happier：消息行、幂等键和 keyset 分页

本地 `research/third-party/happier` commit `d06e287b42e7b73a48159c21731d33d95e966801`。

- `apps/server/prisma/schema.prisma:645-673`：SessionMessage 单条 content、seq、sourceCreatedAt、rowRevision；`(sessionId, localId)` 唯一，`(sessionId, seq)` 与 role/sidechain 索引。借鉴“源端幂等身份”和“服务端排序位置”分离，不复制它的多用户/加密/投递字段全集。
- `apps/server/sources/app/session/sessionWriteService.ts:1189-1251`：事务内找 localId，已有则 reconcile；新消息增加 session.seq 后写 row。我们的 checkpoint 也必须放同一事务，不能先推进字节 offset 后插消息。
- `apps/server/sources/app/api/routes/session/registerSessionMessageRoutes.ts:240-270,363-399`：beforeSeq 与 afterSeq 互斥；按方向排序，`limit+1` 判断 hasMore，返回下一游标。我们可直接借鉴 keyset，无需 OFFSET 或总数 COUNT。
- 同文件 `:322-360`：turn projection 由数据库选需要的消息，避免传全部工具消息后前端丢弃。可作为后续“仅问答视图”的参考，第一版先保留全部支持记录。
- `apps/server/sources/app/retention/rules/sessionMessageRetentionRule.ts:107-159`：保留尾部，按预算分批扫描、删除前再次校验状态。借鉴 bounded cleanup，不照搬其默认保留政策。

### Warp：摘要先加载、正文懒加载

本地 `research/third-party/warp` commit `1f0cf55afb29c71d94f2980b384aa11cb3cdb85a`。

- `crates/persistence/src/model.rs:912-933`：conversation record 的 summary 专用于启动列表，避免解码 task 正文；task 是单独二进制记录。
- `app/src/ai/blocklist/history_model/conversation_loader.rs:333-368`：先查内存，未命中时按 conversationId 读取 SQLite 并转换。
- `app/src/persistence/agent.rs:355-375`：加载指定会话的所有 task。**这条路径不是逐消息分页证据**；我们只借鉴轻量目录与正文分离，不借鉴整会话加载作为长历史方案。

以上是本地源码证据，没有宣称启动或压力测试过这些项目。此子任务无需网络才能判断其数据模型；未使用二手文章作依据。

## 推荐数据与事务边界

身份归档模型以 `01-identity-archive.md` 最终整合为准。conversation 是确认后的 CLI 原生对话身份，generation 是一次绑定及其观测边界，两者不等于 PTY instanceId，也不重用文件 inode。A→B→A 产生三次绑定，A 的正文只保存一份。

| 结构 | 首轮字段 | 目的 |
| --- | --- | --- |
| conversation 元信息 | conversationId PK、已验证 cliId/nativeSessionId/来源作用域、nextHistorySeq、revision、historyEpoch、coverage | 相同原生对话正文去重；身份匹配规则由 01 定义 |
| generation 元信息 | generation PK、webSessionId、conversationId FK、createdAt/closedAt、观测起止/读取边界、revision | 记录绑定历史及当时可见范围；启动只加载摘要 |
| ai_messages | conversationId、historySeq、source、nativeId、parentId、role、createdAt、ingestedAt、previewJson、contentHash、sourceRevision、bodyState、byteLength | `(conversationId,historySeq)` 主键；`(conversationId,source,nativeId)` 唯一；正文列表可按页取 |
| ai_message_bodies | conversationId/source/nativeId FK、bodyJson、byteLength、truncated | 按需读取受支持的完整正文；列表查询不选这一列 |
| transcript checkpoint | conversationId、source、adapterVersion、path/fingerprint、offset、pending/tail、status、skipped、revision、writer generation guard | 与消息 batch 原子提交；在途旧绑定不能推进新绑定的读取状态 |

generation-only 正文表作为替代方案已否决：A→B→A 会重复保存 A，后续需要再迁移所有权。首轮即引入轻量 conversation 实体，但不引入内容寻址 blob 服务。conversation 身份不能仅凭 cwd/title 或文本相同合并；不同来源作用域必须按身份契约隔离。

事务：核对当前 generation/revision → 插入/更新消息和正文 → 分配 historySeq → checkpoint → 更新元信息 → commit → 再向 WS 通知。失败任何一步都不推进读取位置，重试用唯一键去重。Node 同步 SQLite 的单次事务也需控制批量，不能按整文件做长事务。

相同 nativeId + 相同 hash 为 no-op；相同 nativeId + 不同 hash 不能 `INSERT OR IGNORE` 静默丢弃：首轮将其标记为 source_changed 并触发受控 reconciliation，冻结当前页版本；要支持原位修订则需要增加 sourceRevision/historyEpoch 并明确更新事件。文件 reset 不删除旧归档，新增源修订关系；不能把原来的 `record.events.filter(...)` 照搬到历史表。

## 历史游标与 WS replay 分开

historySeq 用于用户向上翻页，只有归档消息分配；streamSeq 用于状态、permission、源切换和消息通知。二者不能用同一个数字代替。现有 afterSeq 继续表示旧 WS 协议语义，增量新增历史 API，避免暗改前端契约。

建议 API 草案：

```text
GET /api/ai-sessions/:id/generations/:generation/messages?limit=50&cursor=...
GET /api/ai-sessions/:id/generations/:generation/messages/:messageId
```

初次返回最新一页，但 items 统一升序，方便前端直接 prepend/append。limit 默认 50、最大 200；列表另设总响应字节预算（建议初始 512 KiB），以实际序列化行边界截断并生成 nextCursor。这些数值是待基准验证的起点。

cursor 版本化编码 `{v,generation,conversationId,historyEpoch,beforeSeq,upperBoundSeq}`；API 经 generation 解析 conversation 和该绑定允许的观测边界，分页在对应 conversation 下执行 `historySeq < beforeSeq AND historySeq <= upperBoundSeq ORDER BY historySeq DESC LIMIT limit+1`，并应用绑定读取边界，反转选中结果再返回。upperBoundSeq 稳定一次历史浏览的边界，期间新增消息从 WS/刷新得到；已关闭 generation 不因 A 后来恢复而悄悄扩张其历史视图。游标不是授权凭证，解析需校验字段范围、conversation 归属和 URL generation 一致。

响应至少 `{items,nextCursor,hasMore,upperBoundSeq,historyEpoch,coverage,retainedFromSeq}`。没有更多当前记录不代表源文件导入完成，应通过 coverage/importStatus 表达。文件重排、分支投影变化或 retention 使游标失效时返回稳定 `cursor_expired`/409，前端重新拉最近页，不能默默漏消息。若只删最前段，明确 retainedFromSeq 也可保留尚有效游标。

WS gap 时拉“最新窗口 + 明确 reset”，不在一次 WS 连接里补发几十万行历史。消息通知携带稳定 messageId/historySeq；旧协议继续兼容，到前端支持分页后再瘦身。新页面的“初次快照与订阅之间”须复用 subscribe-before-snapshot 或 cursor checkpoint，避免分页上线引入竞态漏消息。

## 源文件消失时能保证什么

推荐承诺：已入库的受支持正文持续可读；源文件缺失只让同步状态 stale/unavailable，不隐藏归档；OSC 仍提供当前运行状态。未读取、被主动截断或未知格式的内容不能承诺恢复。

OSC fallback 与 transcript 重叠不能按文本、时间接近或 role 猜去重。首轮将两种 source 都以原始稳定身份归档，历史正文主投影保持已确认 transcript；无法关联的后续 OSC query/response 标记为 `unverified_fallback`，可单独在“同步暂缺期间收到的边界记录”区域提供，不能混成已确认完整正文。若 native turn/message ID 有明确映射，可保存 supersededBy 关系隐藏被替代的 OSC 投影，但归档行不物理删除。transcript 恢复后刷新投影/coverage，不自动用相同文字判定重复，更不能 source 切换就把旧历史清空。首版不具备关联信息时，宁可清楚展示补充来源，也不承诺正文已无重复。

归档证据与当前投影分离：保留源修订和冲突事实，当前源文件截断只改变读取 checkpoint 和当前投影资格。本文第一轮同 id 不同 hash 暂停 reconciliation 的建议正是为了不覆盖既有归档；未来若自动保留多修订，应单独 message revisions 表或修订复合键，而不是覆盖原 bodyJson。historySeq 的上界只固定新增范围，原位修订必须通过 historyEpoch 失效游标，不能假称提供数据库多版本快照。

因此归档阶段要让 parser 返回白名单详情，与消息一起存入正文表，而不是只存 path/offset。现有每行 1 MiB 上限可保留，详情 256 Ki 字符可先沿用并明确 `truncated`；正式预算应用 UTF-8 byteLength，不能把 JS 字符数当字节数。providerPayload、textSignature、环境凭据等原始字段不落归档正文。

老预览数据迁移后若正文尚未读取，bodyState=source_backed；后台或首次访问详情按旧 ref 补齐并持久化。文件已消失则 bodyState=unavailable，预览仍可读。不能用 empty content 假装完整正文。

## IO、保留与迁移

- 保留 reader 的 256 KiB batch、partial checkpoint 和 1 MiB 行限制；增加全局并发/字节配额与轮转公平，避免 100 个历史会话每秒全部打开文件。
- 启动只读 active binding/generation 摘要，历史分页需要时读；不要把新表又 `SELECT *` 全量灌回 bridge Map。
- 列表不 JOIN body；归档 batch 一次事务；有存量 transcript 需补采时分小批在后台跑，主启动不等全量导入。
- 首轮保持现有删除终端会删除本应用相关资料的语义：同事务删除 current binding 和该终端的 generation 关系，清理无人引用的 conversation/message/body/checkpoint；其他终端仍引用的正文不能误删，CLI 原日志始终不删。关闭浏览器、关闭 project 或仅断开连接不等于删除终端，项目删除是否删终端沿用既有接口语义，不附加新的历史删除规则。删除前注销导入，事务中校验关系/revision，防在途任务下一 tick 灌回。永久独立全局档案需另行产品决定，本轮不暗改。
- retention 先提供容量统计、可配置策略与分批清理；不擅自引入 30 天删除。活跃代际/正在分页的快照如何过期必须进 API；删除 message/body、更新 retainedFromSeq/historyEpoch 应同事务。SQLite 删除并不自动缩小文件，不在保存路径强制 VACUUM。
- migration 建新表与 schema marker；按旧记录导入尚保留的 message，保留 generation、源 identity、hash；旧 droppedThrough 标为 history coverage 有缺口。检查点尾部以外历史已丢失时，只能从仍存在的源文件补采，不能宣称迁移恢复了所有历史。
- 先完成可重复 migration + 新存储接口，再改 ingestion 原子写；旧 JSON snapshot 暂保留只作为回滚参考，禁止旧版服务与新版同时双写。读切换通过验证后移除事件大数组，迁移 marker 与数据提交同事务。

## 验收清单

1. 10 万条合成消息，启动不加载正文；最近页、最旧页 keyset 正确，内存不随全部历史线性增长。记录实测延迟/峰值，不预先宣称性能提升倍数。
2. 分页期间持续追加，翻页无重复/遗漏；工具消息与 role 过滤不会使 nextCursor 卡住；中文大内容响应字节预算生效。
3. 批量写中断、数据库失败、checkpoint 写失败：重新打开后只出现一次完整消息，没有“offset 已前进但正文未存”。
4. 删除原 JSONL：已归档的预览/详情仍读得到，未入库详情明确 unavailable；源失效不抹掉 UI 历史。
5. 源重写、同 id 不同 hash、文件截断、inode 变化：保留历史且明确源变更，不静默覆盖、不无限重复；相关页游标按契约失效。
6. generation 切换期间在途 read/详情完成：不能越过新绑定的 guard；未删除终端的老 generation API 仍按观测边界可读。A→B→A 仅两份 conversation 正文、三个绑定关系，A 消息不重复。
7. 旧快照 migration 重跑、半途崩溃、存在 droppedThrough：不重复、coverage 不夸大、marker 原子；单行坏数据明确诊断而非清库。
8. retention 与分页/导入并行，删除后不复活；删除终端删除本应用 current/generation 关系和独占正文，共享 conversation 不误删；关闭浏览器或 project 不等于删除终端；任何资料删除都不删外部 CLI 文件。
9. WS replay 上限仍有效，慢客户端不会触发整库读取，快照/订阅边界不漏新增。

优先实施顺序：先协调 conversation 正文所有权和 generation 关系 → 逐条归档与 checkpoint 事务 → 历史/详情 API及归档换绑 → 新前端消费与旧 snapshot 瘦身 → 可选 retention/投影。数据层和 API 契约是一轮交付，不能只完成表却继续让消费者读旧数组。
