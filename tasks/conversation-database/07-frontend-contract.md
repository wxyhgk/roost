# G1 前端交接：独立对话目录与已保存历史

本阶段提供独立对话查询和整理接口。前端由其他开发者实现。本文描述 G1 接口契约；验收状态以本目录实施与测试记录为准。

## 1. 使用边界

- `conversation.id` 是本应用长期对话 ID，不是终端 session ID，也不是 CLI 的 native session ID。后续 Agent 通讯使用这个 ID。
- 打开列表、对话或正文只读取 SQLite 中已保存的数据，不启动 CLI、不发送提示词，也不主动读取原生 transcript 文件。
- 终端删除后仍可通过这些接口阅读已保存的对话。CLI 是否还可恢复、当前是否在线不由本接口保证。
- G1 不提供发消息、Agent 收件箱、恢复运行或 WebSocket 变更事件。不要将保存元数据成功显示为“AI 已接收”。

## 2. 对话目录

```http
GET /api/conversations?state=active&limit=50
GET /api/conversations?projectId=null&q=计算&limit=20
```

| 参数 | 语义 |
| --- | --- |
| `projectId` | 省略表示全部项目；字面值 `null` 表示未分组；其他非空字符串表示具体项目 ID。`projectId=` 无效。 |
| `q` | 可选标题及已保存消息正文 `content` 的子串搜索，最多 200 个 UTF-16 code unit；正文未完整保存时使用已保存预览，不会追读原生文件。 |
| `state` | `active`（默认）、`archived`、`trashed`、`all`。整理状态不表示 CLI 运行状态。 |
| `limit` | 可选十进制整数，范围 1–200。 |
| `cursor` | 上一页返回的不透明游标；第一屏省略，不能传空字符串。更改筛选后必须重新从第一页请求。 |

未知或重复参数返回 400，例如 `?limit=10&limit=20`。响应为 `{items: ConversationRecord[], nextCursor: string | null}`。当前按 `createdAt DESC, id DESC` 排序，前端直接使用返回顺序；置顶字段本阶段只保存状态，不改变分页排序。`nextCursor: null` 表示没有下一页。

## 3. 对话详情与元数据修改

```http
GET /api/conversations/:conversationId
PATCH /api/conversations/:conversationId
Content-Type: application/json

{"revision":1,"title":"分析计算结果","projectId":null,"pinned":true}
```

详情和 PATCH 成功均返回一个 `ConversationRecord`，不是包裹在 `record` 字段中：

```ts
type ConversationRecord = {
  id: string;
  title: string;
  titleOrigin: 'native' | 'user' | 'fallback';
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  archivedAt: number | null;
  trashedAt: number | null;
  pinnedAt: number | null;
  revision: number;
  forkedFromId: string | null;
  source: {
    id: string;
    conversationId: string;
    legacyConversationId: string;
    originScope: 'legacy-local';
    cliId: string;
    nativeSessionId: string;
    cwd: string | null;
    transcriptPath: string | null;
    locatorStatus: 'unverified';
    observedAt: number;
    coverage: { hasGap: boolean; transcriptStatus?: string; skippedRecords?: number };
  };
};
```

时间戳均为 Unix 毫秒。`locatorStatus: 'unverified'` 表示保存了来源线索，不能据此显示“可继续对话”。前端显示 CLI 名称或图标时，用 `source.cliId` 查询 CLI 配置；不要写死类型。

PATCH 必须包含正整数 `revision`，并至少包含一个修改字段：

| 字段 | 约束 |
| --- | --- |
| `title` | 字符串，去首尾空格后非空且最多 200 个 UTF-16 code unit；禁止控制字符。 |
| `projectId` | 项目 ID 或 JSON `null`；未知项目返回 400。 |
| `archived` | 布尔值，设置或取消归档。 |
| `trashed` | 布尔值，移入或移出回收站；不会物理删除正文。 |
| `pinned` | 布尔值，设置或取消置顶。 |

省略字段保持原值。禁止附带 `source`、`id`、原生身份、运行状态等字段。请求体最多 16 KiB。

版本不一致返回 409：

```json
{
  "error": { "code": "conflict", "message": "..." },
  "current": { "id": "...", "revision": 2 }
}
```

示例中的 `current` 被缩写，实际为完整 `ConversationRecord`。前端保留用户未保存的输入，显示冲突，并让用户比较或重试；禁止静默覆盖。成功后使用响应中的新 revision。

## 4. 阅读已保存历史

```http
GET /api/conversations/:conversationId/messages?limit=50
GET /api/conversations/:conversationId/messages?cursor=上一页游标&limit=50
GET /api/conversations/:conversationId/messages/:messageId
```

路径 ID 使用 `encodeURIComponent`。消息列表只允许 `cursor`、`limit` 参数；对话详情、PATCH 和消息详情不接受 query 参数。

消息沿用 `HistoryMessage`：`messageId`、`historySeq`、结构化 `event`、`bodyState`、`sourceRevision`。消息详情返回该对象，优先使用数据库中的已保存正文。

消息分页响应为：

```ts
{
  items: HistoryMessage[];
  nextCursor: string | null;
  hasMore: boolean;
  upperBoundSeq: number;
  historyEpoch: number;
  conversationId: string;
  coverage: { hasGap: boolean; transcriptStatus?: string; skippedRecords?: number };
}
```

第一屏从最新消息向前取，每页 `items` 已按 `historySeq` 升序排列。下一页是更早的历史，应放在已有内容前面；按 `messageId` 去重。单页另有响应大小上限，所以 `items.length < limit` 不代表结束，必须检查 `hasMore` / `nextCursor`。游标固定首次查询时的消息上界；获取后续新消息需重新请求第一页，不能期待加载更早历史的游标同时收新消息。

| `bodyState` | 前端显示 |
| --- | --- |
| `stored` | 已保存正文可读。 |
| `source_backed` | 这里只保存了预览或来源引用；接口不会追读原生文件补全文。 |
| `unavailable` | 已保存正文不可用；保留已有预览并明确提示，不能显示为空白且假装完整。 |

`coverage.hasGap`、`transcriptStatus`、`skippedRecords` 必须保留给历史完整性提示使用。不要把“列表非空”解释为“完整上下文已保存”，也不要把 `sourceRevision` 当成对话元数据 revision。

## 5. 错误处理

统一形状为 `{error:{code,message}}`，冲突额外包含顶层 `current`。前端按 code 映射文案，message 用于兜底和诊断，不直接把整个 JSON 字符串展示给用户。

| HTTP | code | 处理建议 |
| --- | --- | --- |
| 400 | `invalid_request` | 修正字段、筛选或游标；不循环自动重试。 |
| 404 | `not_found` | 对话或消息不存在；显示无法找到并刷新目录。 |
| 409 | `conflict` | 保留草稿，使用 `current` 处理元数据冲突。 |
| 409 | `history_cursor_expired` | 历史修订导致分页游标过期，重新请求第一页；此错误不携带 `current`。 |
| 405 | `method_not_allowed` | 调用方式错误，响应包含 `Allow`。 |
| 413 | `too_large` | 缩小请求体。 |
| 503 | `storage_unavailable` | 明确显示暂不可用，保留未保存编辑，允许稍后重试。 |

独立历史的游标还可能因历史版本变化而失效。前端应遵循返回的稳定错误 code 重新加载第一页；不能将过期游标无限重试。

## 6. 前端本阶段验收

1. 目录使用长期 conversation ID；关闭或删除终端后仍能重新打开已保存历史。
2. 多窗口同时修改标题，一方收到冲突并保留草稿。
3. 筛选、归档、回收站、置顶根据响应刷新；不将整理状态当成正在运行。
4. 浏览历史无新增终端、无 CLI 启动、无模型请求。
5. 来源不可用或记录有缺口时显示实际覆盖情况。
6. 改筛选清空游标；只对本次请求的筛选和对话 ID 应用响应，防止旧异步响应覆盖新页面。
