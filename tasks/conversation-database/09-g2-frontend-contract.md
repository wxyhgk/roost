# G2 前端交接：持久通讯与变更补收

本文是后端接口契约，不代表已经通过真实 CLI 的 A → B → A 验收。G1 的目录、元数据和历史接口继续有效，见 [G1 契约](07-frontend-contract.md)。

## 1. 用户发信

```http
POST /api/conversations/:recipientConversationId/inbox
Content-Type: application/json

{"requestId":"客户端生成的持久随机ID","text":"请检查最新计算结果"}
```

- 收件人使用长期 conversation ID。HTTP 入口代表当前可信本地用户，发送者固定 `senderKind: 'user'`、`senderConversationId: null`；不能通过 body/header 冒充 A 或其他 Agent。
- Agent 使用独立可信 IPC 入口，不使用这个 HTTP 入口自报身份。身份 context 查询只读返回当前 conversation/run，不返回正文；后续 send/inbox/outbox 必须同时固定预期 `expectedConversationId` 与 `expectedRunId`，身份已变化则拒绝操作。具体运行通道由 G2 实施记录说明。
- body 只允许 `requestId`、`text`、`inReplyTo`。正文换行归一为 LF，最大 **15 KiB UTF-8**，禁止空白正文、非法控制字符和孤立代理项；保留普通换行及 tab。请求体整体上限 128 KiB。
- `requestId` 是一次逻辑发信的稳定 ID，客户端应在发请求之前保存。响应丢失后用原 ID 和原内容重试；同 ID 改收件人、正文或回复关系返回 409 `request_conflict`。不应在每次网络重试时生成新 ID。
- `inReplyTo` 可省略或为 `null`。非空回复关系属于 Agent 原收件人回复原发送者的通道，本用户 HTTP 入口目前返回 400 `invalid_reply`；前端不要把它当任意引用字段。

成功统一返回 **202**（包括幂等重试）和 `{message,delivery}`。202 表示该逻辑请求已有持久记录，**不表示 CLI 已收到**。重试可能返回已经取消、失败或已接收的原始投递；必须检查 `delivery.state`。

```ts
type PeerMessage = {
  id: string;
  senderKind: 'user' | 'agent';
  senderConversationId: string | null;
  senderRunId: string | null;
  senderScope: string;
  requestId: string;
  recipientId: string;
  text: string;
  format: 'text/v1';
  createdAt: number;
  inReplyTo: string | null;
};
```

所有 ID 均视为不透明字符串。路径段使用 `encodeURIComponent`，不要用名称猜测地址或从 ID 中推导权限。

## 2. 收件箱、发件箱与正文

```http
GET /api/conversations/:id/inbox?limit=50
GET /api/conversations/:id/outbox?cursor=上一页游标&limit=50
GET /api/peer-messages/:messageId
```

收发件箱 `limit` 范围 1–100，默认 50；只允许 `cursor`、`limit`，禁止重复参数。第一屏省略游标，不能传空串。游标绑定对话和 inbox/outbox 方向，不能混用。

分页返回 `{items:[{message,delivery}],nextCursor:string|null}`，按 `delivery.enqueueSeq` 倒序排列。列表中 `message` 不包含 `text`，改为 `preview`（最多 512 个 UTF-16 code unit）和 `truncated`；点开后按 message ID 获取完整 `{message,delivery}`。

对话的 outbox 只包含这个 Agent 自己发出的信；用户发给 B 的信出现在 B 的 inbox，不伪装成 A 的 outbox。投递与普通历史消息是不同对象，关联真实原生消息后前端应避免将同一输入重复展示为两条普通对话。

主要投递字段：`id`、`messageId`、`recipientId`、`enqueueSeq`、`state`、`reason`、`revision`、`createdAt`、`updatedAt`、`acceptedNativeMessageId`、`acceptedAt`。其余运行来源字段仅用于诊断，不应作为用户需要手动填写的内容。

| `delivery.state` | 用户文案含义 |
| --- | --- |
| `queued` | 已保存，等待投递；不能显示已送达。 |
| `dispatching` | 正在交给目标运行实例，尚无确认。 |
| `accepted` | 有原生接收证据；不是“AI 已完成回答”。 |
| `uncertain` | 是否收到无法确定，不能自动重发。 |
| `failed` | 此次投递失败，根据 reason 显示原因。 |
| `cancelled` | 已取消。 |

## 3. 取消尚未投递的消息

```http
POST /api/peer-deliveries/:deliveryId/cancel
Content-Type: application/json

{}
```

无请求体也允许。接口不接受任何 body 或 query 字段。返回 200 和最新 `PeerDelivery`；已取消重复请求仍返回相同状态。只有 `queued` 可以取消，其余已开始投递的状态返回 409 `already_dispatching`，不能宣称从 CLI 撤回消息。

## 4. 一致快照与增量变更

```http
GET /api/conversations/:id/snapshot
GET /api/conversations/:id/changes?cursor=快照或上一页返回的游标&limit=100
```

快照响应：

```ts
{
  conversation: ConversationRecord;
  run: ConversationRun | null;
  messages: HistoryPage;
  inbox: PeerPage;
  outbox: PeerPage;
  cursor: string;
}
```

以上字段从同一个数据库读事务获取，三类首屏各取最多 10 条。`messages.nextCursor`、`inbox.nextCursor`、`outbox.nextCursor` 是各自的历史分页游标；顶层 `cursor` 是变更订阅游标，不能混用。

`run` 是数据库当前已观测到的 active 运行记录，没有则为 `null`；它不保证此刻终端可输入，也不表示该对话一定可以恢复。前端不能仅凭 `run !== null` 将消息显示为可即时送达。

changes 返回 `{items,cursor,hasMore}`，每条 item 为：

```ts
{
  seq: number;
  conversationId: string;
  kind: string;
  entityId: string;
  entityRevision: number | null;
  payload: Record<string, unknown>;
  createdAt: number;
}
```

changes `limit` 范围 1–200，另有 512 KiB 单页大小限制。按 `seq` 升序处理，使用响应的 `cursor` 继续读取；`hasMore` 表示需要接着补收。没有传 cursor 时只返回当前游标和空 items，不返回完整历史，因此首次界面初始化应请求 snapshot。

事件是数据失效提示，不携带完整正文：

| kind | 更新方式 |
| --- | --- |
| `conversation.updated` / `source.updated` | 重新读取对话详情。 |
| `history.message.updated` / `history.body.updated` | 按 entityId 读取消息，或刷新历史首屏；处理历史游标过期。 |
| `run.updated` | 运行状态发生变化；不要仅根据此事件推测 CLI 已可接收。 |
| `peer.message.updated` / `peer.delivery.updated` | entityId 是 peer message ID，按详情接口获取最新消息和投递状态。 |

序号为全局序列，按单条对话过滤后有空洞是正常现象。即使 items 为空也要保存返回的 cursor。daemon 每 30 秒清理一次变更日志，保留最新 5000 条全局变更；这是有界补收窗口，不是无限事件归档。游标过期、跨对话、后端实例变化或保留范围不足返回 409 `resync_required`，重新请求 snapshot 后恢复订阅。随机实例标记会让后端正常重启也触发一次重新同步；不支持任意热替换运行中的数据库文件，备份恢复须在服务离线时进行。

## 5. WebSocket 同步

```text
/api/conversations/:id/stream
/api/conversations/:id/stream?cursor=顶层变更游标
```

- 无 cursor：先发送 `{type:'snapshot', ...快照}`。
- 有 cursor：校验后先发送 `{type:'changes',items,cursor,hasMore}`，继续补收；不用非原子“读当前状态再从当前游标开始”方式覆盖离线期间的变化。
- 后续每 250 ms 查询持久变更，每轮最多 100 条；发 `{type:'changes',items,cursor,hasMore}`。它是数据库变更同步，不是模型 token 推流。
- WS 与 HTTP 的顶层变更 cursor 在同一后端实例内通用。按 seq 去重，并保存最后成功应用的 cursor。慢 HTTP 回读不能覆盖已经应用的更新版本。
- 错误帧为 `{type:'error',status,error:{code,message}}`，随后关闭连接。`resync_required` 需要新快照，不能拿旧 cursor 无限重连。
- 该连接只读，客户端发送消息会以 1008 关闭。发信走 POST，不通过 WS 发送终端按键。
- 待发送数据和新帧合计超过 16 MiB 会断开慢客户端；重新连接后从最后成功应用的 cursor 补收，必要时重新取快照。服务释放时清理轮询并以 1012 关闭连接。

## 6. 常见错误码

所有 HTTP 错误统一为 `{error:{code,message}}`。`message` 只作兜底和日志，前端按 code 映射文案。

| HTTP | code | 行为 |
| --- | --- | --- |
| 400 | `invalid_request` | 修正字段、重复 query、空 cursor 或无效数值。 |
| 400 | `invalid_reply` | 当前用户入口不支持指定 Agent 回复关系。 |
| 404 | `not_found` | 收件对话、消息或投递不存在。 |
| 409 | `request_conflict` | 同 requestId 对应不同逻辑消息，不能覆盖原请求。 |
| 409 | `conversation_trashed` | 收件人已在回收站，不能新发信。 |
| 409 | `already_dispatching` | 已进入投递流程，不能取消。 |
| 409 | `resync_required` | 丢弃变更游标，重新取快照。 |
| 413 | `too_large` | 正文或请求体超限。 |
| 429 | `queue_full` | 收件人已有 20 条未决投递，等待或取消尚未投递的消息。 |
| 503 | `storage_unavailable` | 保留输入和 requestId，稍后重试。 |

## 7. 前端验收重点

1. 发信超时重试仍只有一条信，202 不显示为已送达。
2. 目标终端离线仍能保存和查看收件箱；不能把排队信件当成已经进入原生上下文。
3. 两个 GUI 同时打开对话，元数据、历史与投递状态按持久 changes 更新；断线后补收。
4. 后端重启、游标过期或备份恢复后重新 snapshot，避免反复重连旧游标。
5. 用户输入保留；未知状态或错误不能静默当成功。Agent 身份与回复权限通过可信运行通道核验，不由前端自报。
