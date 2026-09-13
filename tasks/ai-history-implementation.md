# AI 耐久历史与分页：P0 实现及前端交接

日期：2026-09-09。对应 [后续调研 P0](ai-sync-research/README.md)。本轮只实现后端；自动换绑、完整分支树和其他 CLI 适配仍未实现。

## 使用者得到什么

- 已采集的消息不再随 4096 条 / 8 MiB 实时缓存淘汰而丢失。
- 新采集的受支持工具详情随消息一起存入 SQLite；CLI 原日志删除后，仍可通过历史接口读取。
- 现有换绑操作会在同一事务中结束旧 generation，保留旧代可查。A→B→A 是三段绑定、两份原生对话身份，未改变的 A 正文不会重复保存。
- 长历史分页面查询。重启后先加载当前绑定元信息，回放窗口按需恢复，不把全部历史灌入内存。

本轮没有让现有前端自动出现历史入口；前端需接下方新 API。原 snapshot/WS 与旧 `/transcript/:eventId` 接口保持兼容，原工具详情入口仍可能依赖源文件，耐久详情请使用新的 messages 入口。

## 存储与提交

`workspace-store/src/ai-history.ts` / `ai-sessions.ts` 管理：

| 表 | 内容 |
| --- | --- |
| ai_conversations | 本地 CLI + nativeSessionId 对话身份、历史序号、修订 epoch |
| ai_generations | 网页终端的绑定时期、ordinal、归档结束时间、历史上界和覆盖状态 |
| ai_history_messages | 标准化消息预览、原生 eventId、不可变修订、historySeq |
| ai_history_bodies | 按需读取的标准化详情 |
| ai_session_replay | 有上限的实时事件回放；与历史独立 |
| ai_session_records | 当前绑定、读取检查点和游标等元信息，不再内嵌事件数组 |
| ai_history_legacy_records | 初次迁移的旧 JSON 参考副本 |

bridge 的 `save(record, expectedRevision, changes)` 使用同一 SQLite savepoint 完成 CAS、历史正文、读取 offset/pending bytes、generation 和回放更新。事务成功后才更新内存并通知 WS。新增消息在缓存裁剪前交给历史存储，不能从裁剪后的数组倒推增量。

transcript reader 每次解析同一行时产生 preview 与 details，详情仅走存储，不塞进 WebSocket 预览。保留原 256 KiB 批次、1 MiB 单行限制及 256 Ki 字符详情限制；超出支持范围仍显示 truncated/partial。调度增加最多 4 个并行读取和轮转，避免大量会话同时打开文件。

正文修订分配新 historySeq/messageId，保留旧正文，令旧分页 cursor 返回 409。文件位置、offset 和采集时间变化本身不算正文变化。旧预览补齐详情必须有相同源行 hash 证明；仅前缀相同不能把后来改变的全文写进旧档案。

## HTTP 契约

所有 ID 和 cursor 按 URL 编码处理。接口无需活跃 PTY；归档代仍可查询。响应 `Cache-Control: no-store`。

```http
GET /api/ai-sessions/:id/generations?limit=50&beforeOrdinal=...
```

返回 `{ items, nextBeforeOrdinal }`，按 ordinal 从新到旧。items 包含 generation、conversationId、binding、openedAt、closedAt、upperBoundSeq、coverage。nextBeforeOrdinal 为 null 时表示已无更多。

```http
GET /api/ai-sessions/:id/generations/:generation/messages?limit=50&cursor=...
```

返回：

```ts
{
  items: Array<{
    messageId: string,       // 不透明历史 ID；详情请求用它，不要用 event.eventId 代替
    historySeq: number,
    sourceRevision: number,
    event: BridgeEvent,     // 列表预览；仍有 role/content/data.parts
    bodyState: "stored" | "source_backed" | "unavailable"
  }>,
  nextCursor: string | null,
  hasMore: boolean,
  upperBoundSeq: number,
  historyEpoch: number,
  conversationId: string,
  coverage: { hasGap: boolean, transcriptStatus?: string, skippedRecords?: number }
}
```

首请求返回最新一页，每页 items 统一升序；nextCursor 用来向前翻，前端 prepend 前一页。limit 默认 50、最大 200。页大小还受 512 KiB 预算约束，因此不能用 `items.length < limit` 判断结束，必须看 hasMore/nextCursor。

cursor 固定本次浏览的 upperBound，并绑定网页终端、generation、conversation 和 historyEpoch；前端不解析、不拼造。新追加记录不会打乱旧分页；发生源修订时返回 `409 history_cursor_expired`，需重新拉最新页。已关闭 generation 的上界固定，不会因为 A 后来恢复而把后续新增消息塞回旧代。

```http
GET /api/ai-sessions/:id/generations/:generation/messages/:messageId
```

返回单个 HistoryMessage，event 改为数据库中保存的详情。此接口不打开 CLI 原文件。

- stored：已保存白名单正文，仍需检查 `event.data.truncated`，不代表无限长度原始日志。
- source_backed：迁移遗留的内容仅保存了预览/原文件定位，未验证详情可得；新接口不自动读文件补齐，不能把预览当全文。
- unavailable：正文行缺失，仍返回可用预览并明确状态。

错误形状统一 `{ error: { code, message } }`：非法参数 400/invalid_request；未知会话、代或消息 404/not_found；分页修订冲突 409/history_cursor_expired；存储失败 503/storage_unavailable；非 GET 为 405/method_not_allowed。OPTIONS 沿用全局预检。

## 前端注意事项

1. 实时 afterSeq 与 historySeq 是两种游标；历史翻页不能推进 WS 游标或触发终端 resume。
2. 原生 eventId 可有多个修订，messageId 才是历史行 ID。历史接口保留修订事实，不自动把所有修订合并成“当前对话”。
3. OSC 与 transcript 分来源保留，`event.data.source` 可识别来源。历史接口不按文本/时间猜去重，也不自动过滤 OSC。推荐正文使用 transcript，未关联的 OSC 放补充来源视图，避免将两份问答都当主正文。
4. 源文件不可读时，已有耐久历史仍可读；现有实时 snapshot 的 OSC 回退行为未改。页面需区分历史内容和当前同步新鲜度。
5. 当前仅保留消息上的 parentId 等字段，没有完整 metadata 结构树，也没有可靠 TUI 活动 leaf 信号，不能宣称当前分支完全同步。

## 迁移、删除与版本边界

首次打开在事务中把旧 JSON **尚保留的**消息和回放导入新表，保留原始 JSON 参考，写入迁移标记；失败全部回滚，可重试。缓存已淘汰部分标 hasGap，无法自动恢复；详情未采集部分标 source_backed。首次迁移会同步扫描旧缓存，耗时取决于存量；正常重启只加载元信息。

新记录使用 storageFormat=2，并用触发器拒绝缺失格式标记的旧 writer。旧版直接读取新记录也不能按原 events 数组启动。该机制针对本项目旧写入路径，不是任意程序写库的权限隔离。

**升级后不能直接让旧 gateway 写这份数据库。** 参考副本只有初次迁移时的数据，不含后续新历史，不是完整回滚备份；若需要运行旧版本，应使用升级前独立数据库备份。日常 daemon 无需因本功能重启。

删除网页终端沿用原有语义：在同一事务删除当前绑定、该终端的 generation、journal、replay 和迁移参考，清理无人引用的正文；其他终端仍引用的 conversation 保留。绝不删除 CLI 原文件。关闭浏览器、网关重启和删除 project 不额外触发历史删除。

## 验证

- SQLite：分页期间追加、固定上界、不可变修订、游标过期、旧预览补全文的源 hash、Unicode 长 ID、大预览页预算、迁移重跑、中间 schema 升级、旧 writer 拒收。
- 故障：真实 SQLite trigger 注入正文写失败，验证 checkpoint/历史/回放一起回滚；终端删除触发失败，验证跨表删除一起回滚；共享正文不误删。
- 规模：10 万条合成消息验证 metadata-only 启动读取及最新页查询；不是真实用户负载延迟承诺。
- 后端集成：replay 只留 1 条但 batch 3 条全部归档、A→B→A、无活 PTY 查询、源文件删除后详情可读。
- 真实 omp：隔离数据目录/端口与 daemon，网关停机补收、SIGKILL 后恢复、HTTP/WS、耐久历史与删除原日志后的详情读取通过。未主动重启日常 daemon。

命令：`npm test --workspace backend --workspace @roost/workspace-store --workspace @roost/ai-session-bridge --workspace @roost/ai-transcript`；真实用例：`ROOST_VERIFY_OMP=1 ROOST_OMP_WORKTREE=/tmp/diy-omp-readonly-sync node --import tsx --test backend/tests/omp-live.test.ts`。

后续 [P1 安全自动换绑](ai-auto-rebind-implementation.md) 已实现：连续可靠来源可自动跟随，有正文但证据不足仍保持 needs_rebind。实际边界以 P1 说明为准。
